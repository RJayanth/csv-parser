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
  const writePromises = [];

  // Track the last reported percentage to throttle React renders
  let lastReportedPercent = -1;

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
          writePromises.push(saveBatchToDB([...dbBuffer]));
        }
        
        self.postMessage({ type: 'STATUS', message: "Finalizing storage commit..." });
        await Promise.all(writePromises);
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

            // Fast async write in background
            if (dbBuffer.length >= 50) {
              writePromises.push(saveBatchToDB([...dbBuffer]));
              dbBuffer = [];
            }

            blockIndex++;
            blockStartByte = currentBlockEndByte;
          }
        }
      }

      leftoverBytes = chunk.subarray(lineStart);
      globalByteOffset += lineStart;

      // ── THRU-PUT OPTIMIZATION: Only notify React when progress goes up by at least 1.0% ──
      const rawPercentage = (globalByteOffset / fileSize) * 100;
      const roundedPercent = Math.floor(rawPercentage);
      
      if (roundedPercent > lastReportedPercent && roundedPercent < 100) {
        lastReportedPercent = roundedPercent;
        self.postMessage({ 
          type: 'PROGRESS', 
          totalSoFar: rowCount,
          message: `Mapping blocks... ${rawPercentage.toFixed(1)}%`
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
    const transaction = db.transaction("blocks", "readwrite", { durability: "relaxed" });
    const store = transaction.objectStore("blocks");
    for (let i = 0; i < batch.length; i++) {
      store.put(batch[i]);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(transaction.error);
  });
}