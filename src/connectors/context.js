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

export async function attachImagesToLastUser(context, sources, listImages, loadImage) {
  const imageUrls = [];
  for (const source of sources) {
    for (const image of listImages(source)) {
      const dataUrl = await loadImage(image);
      if (dataUrl) {
        imageUrls.push(dataUrl);
      }
    }
  }
  if (imageUrls.length === 0) {
    return context;
  }

  let lastUserIndex = -1;
  for (let index = context.length - 1; index >= 0; index--) {
    if (context[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex === -1) {
    return context;
  }

  const enriched = [...context];
  const parts = [];
  const text = context[lastUserIndex].content;
  if (typeof text === "string" && text.trim()) {
    parts.push({ type: "input_text", text });
  }
  for (const imageUrl of imageUrls) {
    parts.push({ type: "input_image", image_url: imageUrl });
  }
  enriched[lastUserIndex] = { role: "user", content: parts };
  return enriched;
}
