import { useState, useEffect } from "react";
import { apiFetch, apiPut } from "../api";
import Markdown from "react-markdown";

export function DocsPage({ botId }: { botId: string }) {
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!botId) return;
    setLoading(true);
    apiFetch(`/bots/${botId}/docs`)
      .then((doc: any) => {
        setContent(doc?.content ?? "");
        setDraft(doc?.content ?? "");
      })
      .catch(() => { setContent(""); setDraft(""); })
      .finally(() => setLoading(false));
  }, [botId]);

  const save = async () => {
    setSaving(true);
    try {
      await apiPut(`/bots/${botId}/docs`, { content: draft });
      setContent(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-32 text-[#8b949e] text-sm">Loading docs…</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#e6edf3] flex items-center gap-2">
            <span>📖</span>Bot Knowledge
          </h2>
          <p className="text-sm text-[#8b949e] mt-0.5">
            Kiến thức bot đã học — được inject vào mỗi request. Bot cũng tự cập nhật khi user dạy.
          </p>
        </div>
        {!editing ? (
          <button
            onClick={() => { setDraft(content); setEditing(true); }}
            className="flex items-center gap-1.5 bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] text-sm font-medium px-4 py-2 rounded-lg border border-[#30363d] transition-colors"
          >
            ✏️ Edit
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(false)}
              className="px-4 py-2 text-sm text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-1.5 bg-[#238636] hover:bg-[#2ea043] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "💾 Save"}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="grid grid-cols-2 gap-4 h-[calc(100vh-200px)]">
          {/* Editor */}
          <div className="bg-[#0d1117] border border-[#30363d] rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-2 bg-[#161b22] border-b border-[#21262d] text-xs font-semibold text-[#8b949e]">
              Editor (Markdown)
            </div>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="flex-1 bg-transparent text-[#e6edf3] text-sm font-mono p-4 resize-none focus:outline-none leading-relaxed"
              placeholder="# Kiến thức bot&#10;&#10;## Khi user hỏi nhập đơn hàng:&#10;→ Gọi start_form('Form nhập đơn hàng')&#10;&#10;## File quan trọng:&#10;- cam_nang_sale.docx → cẩm nang sản phẩm"
            />
          </div>

          {/* Preview */}
          <div className="bg-[#161b22] border border-[#21262d] rounded-xl overflow-hidden flex flex-col">
            <div className="px-4 py-2 bg-[#161b22] border-b border-[#21262d] text-xs font-semibold text-[#8b949e]">
              Preview
            </div>
            <div className="flex-1 overflow-y-auto p-5 prose prose-invert prose-sm max-w-none
              prose-headings:text-[#e6edf3] prose-headings:border-b prose-headings:border-[#21262d] prose-headings:pb-2
              prose-p:text-[#e6edf3] prose-li:text-[#e6edf3]
              prose-code:bg-[#0d1117] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[#79c0ff] prose-code:text-xs
              prose-pre:bg-[#0d1117] prose-pre:border prose-pre:border-[#21262d]
              prose-strong:text-[#e6edf3]
              prose-a:text-[#388bfd]
            ">
              <Markdown>{draft || "*No content yet*"}</Markdown>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#161b22] border border-[#21262d] rounded-xl overflow-hidden">
          {content ? (
            <div className="p-6 prose prose-invert prose-sm max-w-none
              prose-headings:text-[#e6edf3] prose-headings:border-b prose-headings:border-[#21262d] prose-headings:pb-2
              prose-p:text-[#e6edf3] prose-li:text-[#e6edf3]
              prose-code:bg-[#0d1117] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[#79c0ff] prose-code:text-xs
              prose-pre:bg-[#0d1117] prose-pre:border prose-pre:border-[#21262d]
              prose-strong:text-[#e6edf3]
              prose-a:text-[#388bfd]
            ">
              <Markdown>{content}</Markdown>
            </div>
          ) : (
            <div className="py-16 text-center">
              <div className="text-3xl mb-3 opacity-30">📖</div>
              <p className="text-[#8b949e] text-sm">Bot chưa có kiến thức nào</p>
              <p className="text-xs text-[#8b949e]/60 mt-1">Nhắn bot "nhớ cái này..." hoặc click Edit để thêm</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
