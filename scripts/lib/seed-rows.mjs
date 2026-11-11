export function seedRows(page, rowsByTable) {
  return page.evaluate((tables) => new Promise((resolve, reject) => {
    const request = indexedDB.open("exam-tracker-v3");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(Object.keys(tables), "readwrite");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
      for (const [name, rows] of Object.entries(tables)) {
        const table = tx.objectStore(name);
        rows.forEach((row) => table.put(row));
      }
    };
  }), rowsByTable);
}
