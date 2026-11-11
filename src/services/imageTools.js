export async function compressImage(file, options = {}) {
  const maxBytes = options.maxBytes || 1.8 * 1024 * 1024;
  let maxSize = options.maxSize || 1600;
  let quality = options.quality || 0.82;
  const source = await loadImageSource(file);
  let result = null;

  for (let attempt = 0; attempt < 7; attempt += 1) {
    result = await renderImage(source, maxSize, quality);
    if (result.blob.size <= maxBytes) break;
    if (quality > 0.56) {
      quality -= 0.12;
    } else {
      maxSize = Math.max(900, Math.round(maxSize * 0.78));
      quality = 0.74;
    }
  }

  source.close?.();
  URL.revokeObjectURL(source.url);

  const safeName = (file.name.replace(/\.[^.]+$/, "") || "mistake-image").replace(/[^\w\u4e00-\u9fa5-]+/g, "-");
  return {
    file: new File([result.blob], `${safeName}.webp`, { type: result.blob.type || "image/webp" }),
    width: result.width,
    height: result.height
  };
}

async function loadImageSource(file) {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.(), url: "" };
  }

  const url = URL.createObjectURL(file);
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片读取失败"));
    element.src = url;
  });
  return { image, width: image.naturalWidth, height: image.naturalHeight, url };
}

async function renderImage(source, maxSize, quality) {
  const ratio = Math.min(1, maxSize / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(source.image, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, "image/webp", quality).catch(() => canvasToBlob(canvas, "image/jpeg", quality));
  return { blob, width, height };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片压缩失败"));
    }, type, quality);
  });
}
