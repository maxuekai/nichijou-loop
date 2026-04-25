import { useEffect, useState, useRef } from "react";
import { api } from "../../api";
import { Select } from "../../components/ui/Select";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function ChatPage() {
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedMember, setSelectedMember] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getFamily().then((data) => {
      setMembers(data.members);
      if (data.members.length > 0) setSelectedMember(data.members[0]!.id);
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    if (!input.trim() || !selectedMember || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const res = await api.chat(selectedMember, userMsg);
      setMessages((prev) => [...prev, { role: "assistant", content: res.response }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: "assistant", content: `错误: ${err instanceof Error ? err.message : String(err)}` }]);
    }

    setLoading(false);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">与管家对话</h1>
        <Select
          value={selectedMember}
          onChange={(next) => { setSelectedMember(next); setMessages([]); }}
          options={members.map((m) => ({ value: m.id, label: m.name }))}
          placeholder="暂无成员"
          disabled={members.length === 0}
          className="w-44"
        />
      </div>

      <div className="bg-white rounded-xl border border-stone-200 flex flex-col" style={{ height: "calc(100vh - 240px)" }}>
        <div className="flex-1 overflow-auto p-6 space-y-4">
          {messages.length === 0 && (
            <p className="text-center text-stone-400 mt-20">开始与管家对话吧</p>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[70%] px-4 py-3 rounded-2xl text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-amber-500 text-white rounded-br-md"
                  : "bg-stone-100 text-stone-800 rounded-bl-md"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-stone-100 text-stone-400 px-4 py-3 rounded-2xl rounded-bl-md text-sm">
                思考中...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-stone-100 p-4 flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder="输入消息..."
            disabled={!selectedMember || loading}
            className="flex-1 px-4 py-2.5 rounded-xl border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!selectedMember || !input.trim() || loading}
            className="px-6 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 transition-colors"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
