"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const CLAMP_PX = 200;

// 노하우 본문: GFM(표·취소선) 렌더 + 인라인 접기. 내용이 CLAMP_PX를 넘으면
// 미리보기(클램프 + 하단 페이드)로 접고 "더보기"/"접기" 토글을 노출한다.
export default function PostBody({ markdown, anchorId }: { markdown: string; anchorId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflow(el.scrollHeight > CLAMP_PX + 8);
  }, [markdown]);

  // 딥링크(`/knowhow#<id>`)로 들어오면 해당 글을 펼친 채로 보여준다.
  useEffect(() => {
    const reveal = () => { if (anchorId && window.location.hash === `#${anchorId}`) setCollapsed(false); };
    const frame = requestAnimationFrame(reveal);
    window.addEventListener("hashchange", reveal);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", reveal); };
  }, [anchorId]);

  const clamp = overflow && collapsed;
  return (
    <div>
      <div
        ref={ref}
        className="knowhow-md"
        style={
          clamp
            ? {
                maxHeight: CLAMP_PX,
                overflow: "hidden",
                WebkitMaskImage: "linear-gradient(to bottom, #000 65%, transparent)",
                maskImage: "linear-gradient(to bottom, #000 65%, transparent)",
              }
            : undefined
        }
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
      {overflow && (
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="mt-1 text-xs font-medium text-[var(--accent)]"
        >
          {collapsed ? "더보기" : "접기"}
        </button>
      )}
    </div>
  );
}
