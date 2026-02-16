import './code-theme.css'
import { CodeSelection } from '@/lib/messages'
import Prism from 'prismjs'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-typescript'
import { Copy, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface Position {
  top: number
  left: number
}

export function CodeView({
  code,
  lang,
  sourceCode,
  fileName,
  onAttachCode,
  codeSelections,
  scrollToSelection,
}: {
  code: string
  lang: string
  sourceCode?: string
  fileName?: string
  onAttachCode?: (selection: CodeSelection) => void
  codeSelections?: CodeSelection[]
  scrollToSelection?: CodeSelection | null
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const [floatingBtn, setFloatingBtn] = useState<Position | null>(null)
  const [contextMenu, setContextMenu] = useState<Position | null>(null)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)

  useEffect(() => {
    Prism.highlightAll()
  }, [code])

  const handleMouseUp = useCallback(() => {
    if (!onAttachCode || !sourceCode || !fileName) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      setFloatingBtn(null)
      setPendingSelection(null)
      return
    }

    const range = selection.getRangeAt(0)
    if (!preRef.current?.contains(range.commonAncestorContainer)) {
      setFloatingBtn(null)
      setPendingSelection(null)
      return
    }

    const selectedText = selection.toString().trim()
    if (selectedText.length === 0) {
      setFloatingBtn(null)
      setPendingSelection(null)
      return
    }

    const rect = range.getBoundingClientRect()
    const preRect = preRef.current.getBoundingClientRect()
    setFloatingBtn({
      top: rect.bottom - preRect.top + 4,
      left: rect.left - preRect.left + rect.width / 2,
    })
    setPendingSelection(selectedText)
  }, [onAttachCode, sourceCode, fileName])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onAttachCode || !sourceCode || !fileName) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const selectedText = selection.toString().trim()
    if (selectedText.length === 0) return

    const range = selection.getRangeAt(0)
    if (!preRef.current?.contains(range.commonAncestorContainer)) return

    e.preventDefault()

    const preRect = preRef.current.getBoundingClientRect()
    setContextMenu({
      top: e.clientY - preRect.top,
      left: e.clientX - preRect.left,
    })
    setPendingSelection(selectedText)
  }, [onAttachCode, sourceCode, fileName])

  const handleAttach = useCallback(() => {
    if (!pendingSelection || !sourceCode || !fileName || !onAttachCode) return

    const charOffset = sourceCode.indexOf(pendingSelection)
    if (charOffset === -1) return

    const startLine = sourceCode.substring(0, charOffset).split('\n').length
    const endLine = startLine + pendingSelection.split('\n').length - 1
    const lines = sourceCode.split('\n')
    const precedingLine = startLine >= 2 ? lines[startLine - 2].trim() : ''

    onAttachCode({
      code: pendingSelection,
      fileName,
      startLine,
      endLine,
      precedingLine,
    })
    setFloatingBtn(null)
    setContextMenu(null)
    setPendingSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [pendingSelection, sourceCode, fileName, onAttachCode])

  const handleContextMenuCopy = useCallback(() => {
    if (pendingSelection) {
      navigator.clipboard.writeText(pendingSelection)
    }
    setContextMenu(null)
  }, [pendingSelection])

  // Hide floating button and context menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (preRef.current && !preRef.current.contains(e.target as Node)) {
        setFloatingBtn(null)
        setContextMenu(null)
        setPendingSelection(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Auto-scroll to selection when hovering a chip in chat input
  useEffect(() => {
    if (!scrollToSelection || !preRef.current) return
    if (scrollToSelection.fileName !== fileName) return

    const lineEl = preRef.current.querySelector(
      `[data-line="${scrollToSelection.startLine}"]`,
    )
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [scrollToSelection, fileName])

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return
    function handleClick() {
      setContextMenu(null)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [contextMenu])

  // Render code with line-by-line highlighting for attached selections
  const renderCode = () => {
    const fileSelections = codeSelections?.filter((s) => s.fileName === fileName) || []
    if (fileSelections.length === 0) {
      return <code className={`language-${lang}`}>{code}</code>
    }

    const lines = code.split('\n')
    return (
      <code className={`language-${lang}`}>
        {lines.map((line, index) => {
          const lineNum = index + 1
          const isHighlighted = fileSelections.some(
            (s) => lineNum >= s.startLine && lineNum <= s.endLine,
          )
          return (
            <div
              key={index}
              data-line={lineNum}
              className={isHighlighted ? 'bg-primary/10 -mx-4 px-4' : ''}
            >
              {line}
              {index < lines.length - 1 ? '\n' : ''}
            </div>
          )
        })}
      </code>
    )
  }

  return (
    <pre
      ref={preRef}
      className="p-4 pt-2 relative"
      style={{
        fontSize: 12,
        backgroundColor: 'transparent',
        borderRadius: 0,
        margin: 0,
      }}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      {renderCode()}
      {floatingBtn && !contextMenu && (
        <button
          onClick={handleAttach}
          className="absolute z-50 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg shadow-lg border bg-background hover:bg-muted text-foreground transition-colors"
          style={{
            top: floatingBtn.top,
            left: floatingBtn.left,
            transform: 'translateX(-50%)',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Paperclip className="h-3 w-3" />
          Attach to chat
        </button>
      )}
      {contextMenu && (
        <div
          className="absolute z-50 min-w-[160px] rounded-lg shadow-lg border bg-popover text-popover-foreground overflow-hidden"
          style={{
            top: contextMenu.top,
            left: contextMenu.left,
          }}
        >
          <button
            onClick={handleAttach}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-muted transition-colors text-left"
          >
            <Paperclip className="h-3.5 w-3.5" />
            Attach to chat
          </button>
          <div className="border-t" />
          <button
            onClick={handleContextMenuCopy}
            className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-muted transition-colors text-left"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy
          </button>
        </div>
      )}
    </pre>
  )
}
