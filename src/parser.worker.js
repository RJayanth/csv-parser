// parser.worker.js
let db = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("LargeCSVDatabase", 2);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("blocks")) {
        database.createObjectStore("blocks", { keyPath: "blockIndex" });
      }
    };
    request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    request.onerror = (e) => reject(e.target.error);
  });
}

self.onmessage = async (e) => {
  const { file } = e.data;
  if (!file) return;

  self.postMessage({ type: 'STATUS', message: "Initializing lightning index..." });
  await initDB();

  const txClear = db.transaction("blocks", "readwrite");
  txClear.objectStore("blocks").clear();

  const stream = file.stream();
  const reader = stream.getReader();
  
  let rowCount = 0;
  let globalByteOffset = 0;
  let leftoverBytes = new Uint8Array(0);
  const fileSize = file.size;

  let blockIndex = 0;
  const ROWS_PER_BLOCK = 5000;
  let blockStartByte = 0;

  let dbBuffer = [];

  self.postMessage({ type: 'STATUS', message: "Accelerating file mapping..." });

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        if (rowCount > blockIndex * ROWS_PER_BLOCK) {
          dbBuffer.push({
            blockIndex: blockIndex,
            startByte: blockStartByte,
            endByte: fileSize,
            startRow: blockIndex * ROWS_PER_BLOCK,
            endRow: rowCount - 1
          });
        }
        if (dbBuffer.length > 0) {
          await saveBatchToDB(dbBuffer);
        }
        break;
      }

      const chunk = new Uint8Array(leftoverBytes.length + value.length);
      chunk.set(leftoverBytes);
      chunk.set(value, leftoverBytes.length);

      let lineStart = 0;
      
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) { 
          rowCount++;
          lineStart = i + 1;

          if (rowCount % ROWS_PER_BLOCK === 0) {
            const currentBlockEndByte = globalByteOffset + lineStart;
            dbBuffer.push({
              blockIndex: blockIndex,
              startByte: blockStartByte,
              endByte: currentBlockEndByte,
              startRow: blockIndex * ROWS_PER_BLOCK,
              endRow: rowCount - 1
            });

            if (dbBuffer.length >= 50) {
              await saveBatchToDB(dbBuffer);
              dbBuffer = [];
            }

            blockIndex++;
            blockStartByte = currentBlockEndByte;
          }
        }
      }

      leftoverBytes = chunk.subarray(lineStart);
      globalByteOffset += lineStart;

      const percentage = Math.min(((globalByteOffset / fileSize) * 100), 99).toFixed(1);
      self.postMessage({ 
        type: 'PROGRESS', 
        totalSoFar: rowCount,
        message: `Mapping blocks... ${percentage}%`
      });
    }

    self.postMessage({ type: 'DONE', totalRows: rowCount });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error.message });
  }
};

function saveBatchToDB(batch) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("blocks", "readwrite", { durability: "relaxed" });
    const store = transaction.objectStore("blocks");
    for (let i = 0; i < batch.length; i++) {
      store.put(batch[i]);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(transaction.error);
  });
}