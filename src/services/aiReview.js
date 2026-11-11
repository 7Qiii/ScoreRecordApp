import { compressImage } from "./imageTools";
import { getSession } from "./supabase";

export async function analyzeMistakeImage(file, context = {}) {
  const compressed = await compressImage(file, {
    maxBytes: 900 * 1024,
    maxSize: 1400,
    quality: 0.8
  });
  const imageDataUrl = await fileToDataUrl(compressed.file);
  return requestAiReview({ imageDataUrl, ...context });
}

export async function analyzeMistakeImageUrl(imageUrl, context = {}) {
  return requestAiReview({ imageUrl, ...context });
}

async function requestAiReview(payload) {
  const session = await getSession();
  const token = session?.access_token;

  const response = await fetch("/api/ai-review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}
