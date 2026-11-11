export async function downloadBackup(store, prefix = "exam-tracker-backup") {
  const data = await store.exportData();
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    store.markBackupExported();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
