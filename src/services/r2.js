export async function uploadMistakeImage(file, mistakeId, authToken, imageId = "") {
  const response = await fetch("/api/r2-upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      mistakeId,
      imageId,
      fileName: file.name,
      contentType: file.type,
      size: file.size
    })
  });

  if (!response.ok) {
    const message = await response.text();
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const upload = await response.json();
  const putResponse = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": file.type
    },
    body: file
  });

  if (!putResponse.ok) {
    throw new Error("图片上传到 R2 失败");
  }

  return upload;
}
