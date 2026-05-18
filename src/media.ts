import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { MAX_OUTBOUND_MEDIA_BYTES } from "./constants.js";
import type { OutboundMediaContext } from "./types.js";

export function mimeTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
  if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export function mediaKindFromMime(mimeType: string): "audio" | "image" | "video" | "file" {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

export function parseDataUrl(mediaUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/i.exec(mediaUrl);
  if (!match) return null;
  return {
    buffer: Buffer.from(match[2] || "", "base64"),
    mimeType: match[1] || "application/octet-stream",
  };
}

export async function loadOutboundMedia(ctx: OutboundMediaContext): Promise<{
  buffer: Buffer;
  mimeType: string;
  filename: string;
}> {
  const mediaUrl = ctx.mediaUrl || "";
  if (!mediaUrl) throw new Error("No mediaUrl provided");

  const dataUrl = parseDataUrl(mediaUrl);
  if (dataUrl) {
    return { ...dataUrl, filename: "attachment" };
  }

  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetch(mediaUrl);
    if (!response.ok) throw new Error(`Media fetch failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
      throw new Error("Media file is too large for cloud-relay websocket delivery");
    }
    const urlPath = new URL(mediaUrl).pathname;
    return {
      buffer,
      mimeType: response.headers.get("content-type") || mimeTypeFromPath(urlPath),
      filename: basename(urlPath) || "attachment",
    };
  }

  const read =
    ctx.mediaAccess?.readFile ||
    ctx.mediaReadFile ||
    (async (filePath: string) => await readFile(filePath));
  const physicalPath =
    mediaUrl.startsWith("file://")
      ? new URL(mediaUrl)
      : ctx.mediaAccess?.workspaceDir && !mediaUrl.startsWith("/")
        ? resolve(ctx.mediaAccess.workspaceDir, mediaUrl)
        : mediaUrl;
  const buffer = await read(physicalPath instanceof URL ? physicalPath.pathname : physicalPath);
  if (buffer.byteLength > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new Error("Media file is too large for cloud-relay websocket delivery");
  }
  const filename = basename(physicalPath instanceof URL ? physicalPath.pathname : physicalPath) || "attachment";
  return { buffer, mimeType: mimeTypeFromPath(filename), filename };
}
