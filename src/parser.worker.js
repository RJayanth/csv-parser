// parser.worker.js

let db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("LargeCSVDatabase", 1);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("rows")) {
        database.createObjectStore("rows", { keyPath: "id" });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

self.onmessage = async (e) => {
  const { file } = e.data;
  if (!file) return;

  self.postMessage({ type: 'STATUS', message: "Initializing index database..." });
  await initDB();

  // Instant clean
  const txClear = db.transaction("rows", "readwrite");
  txClear.objectStore("rows").clear();

  const stream = file.stream();
  const reader = stream.getReader();
  
  let rowCount = 0;
  let globalByteOffset = 0;
  let leftoverBytes = new Uint8Array(0);
  const fileSize = file.size;

  let bulkBuffer = [];
  const BULK_COMMIT_SIZE = 100000; // Large buffer for speed

  self.postMessage({ type: 'STATUS', message: "Indexing file structure..." });

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        if (leftoverBytes.length > 0) {
          bulkBuffer.push({ id: rowCount, start: globalByteOffset, len: leftoverBytes.length });
          rowCount++;
        }
        if (bulkBuffer.length > 0) {
          await saveBatchToDB(bulkBuffer);
        }
        break;
      }

      // Merge leftover bytes with the new chunk
      const chunk = new Uint8Array(leftoverBytes.length + value.length);
      chunk.set(leftoverBytes);
      chunk.set(value, leftoverBytes.length);

      let lineStart = 0;
      
      // Fast binary scan for newlines (\n is byte 10)
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) { // Newline '\n' character
          const lineLength = i - lineStart + 1;
          bulkBuffer.push({
            id: rowCount,
            start: globalByteOffset + lineStart,
            len: lineLength
          });
          rowCount++;
          lineStart = i + 1;
        }
      }

      // Preserve trailing incomplete line bytes
      leftoverBytes = chunk.subarray(lineStart);
      globalByteOffset += lineStart;

      // Batch save the offset integers to disk
      if (bulkBuffer.length >= BULK_COMMIT_SIZE) {
        await saveBatchToDB(bulkBuffer);
        bulkBuffer = [];

        const percentage = Math.min(((globalByteOffset / fileSize) * 100), 99).toFixed(1);
        self.postMessage({ 
          type: 'PROGRESS', 
          totalSoFar: rowCount,
          message: `Mapping... Indexed ${rowCount.toLocaleString()} rows (${percentage}%)`
        });
      }
    }

    self.postMessage({ type: 'DONE', totalRows: rowCount });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error.message });
  }
};

function saveBatchToDB(batch) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("rows", "readwrite", { durability: "relaxed" });
    const store = transaction.objectStore("rows");
    for (let i = 0; i < batch.length; i++) {
      store.put(batch[i]);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(transaction.error);
  });
}