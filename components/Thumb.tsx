"use client";

import { useEffect, useState } from "react";

/** Renders a stored thumbnail Blob, managing its object URL. */
export default function Thumb({ blob, alt, className }: { blob?: Blob; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={alt} className={className} draggable={false} /> : <div className={`${className ?? ""} thumb-empty`} />;
}
