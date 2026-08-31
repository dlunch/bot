export class CurrentUserImageLoadError extends Error {
  constructor() {
    super("Current user image-only request could not load any supported images");
    this.name = "CurrentUserImageLoadError";
    this.code = "CURRENT_USER_IMAGE_LOAD_FAILED";
  }
}

export async function collectRecentContext(candidates, maxContextBytes, materialize) {
  const selected = [];
  let usedBytes = 0;

  for await (const candidate of candidates) {
    const message = await materialize(candidate);
    if (!message) {
      continue;
    }

    const messageBytes = Buffer.byteLength(message.content, "utf8");
    if (selected.length > 0 && usedBytes + messageBytes > maxContextBytes) {
      break;
    }

    selected.push(message);
    usedBytes += messageBytes;
  }

  return selected.reverse();
}

export async function attachImagesToUserTurns(context, sources, listImages, loadImage) {
  let lastUserIndex = -1;
  for (let index = context.length - 1; index >= 0; index--) {
    if (context[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const enriched = [];
  for (let index = 0; index < context.length; index++) {
    const message = context[index];
    const originalContent = message.content;
    const copiedContent = Array.isArray(originalContent)
      ? originalContent.map((part) => ({ ...part }))
      : originalContent;

    if (message.role !== "user") {
      enriched.push({ ...message, content: copiedContent });
      continue;
    }

    const imageUrls = [];
    for (const image of listImages(sources[index])) {
      const dataUrl = await loadImage(image);
      if (dataUrl) {
        imageUrls.push(dataUrl);
      }
    }

    if (imageUrls.length === 0) {
      const hasContent = Array.isArray(copiedContent)
        ? copiedContent.length > 0
        : typeof copiedContent === "string" && copiedContent.trim();
      if (hasContent) {
        enriched.push({ ...message, content: copiedContent });
      } else if (index === lastUserIndex) {
        throw new CurrentUserImageLoadError();
      }
      continue;
    }

    const parts = Array.isArray(copiedContent) ? copiedContent : [];
    if (typeof copiedContent === "string" && copiedContent.trim()) {
      parts.push({ type: "input_text", text: copiedContent });
    }
    for (const imageUrl of imageUrls) {
      parts.push({ type: "input_image", image_url: imageUrl });
    }
    enriched.push({ ...message, content: parts });
  }
  return enriched;
}
