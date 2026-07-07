// parser.worker.js

// Listen for the file from the main React thread
self.onmessage = async (e) => {
  const { file } = e.data;
  
  // 1. Get a stream reader from the file
  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  
  let leftover = "";
  let rowCount = 0;

  try {
    while (true) {
      // 2. Read the file chunk-by-chunk (typically 64KB - few MBs depending on browser)
      const { done, value } = await reader.read();
      
      if (done) {
        // Process any final remaining text
        if (leftover.length > 0) {
          const finalRow = parseCSVLine(leftover);
          self.postMessage({ type: 'DATA', rows: [finalRow] });
        }
        break;
      }

      // 3. Decode binary Uint8Array chunk to string text
      const chunkText = leftover + decoder.decode(value, { stream: true });
      
      // 4. Split by newlines (handles both Windows \r\n and Unix \n)
      const lines = chunkText.split(/\r?\n/);
      
      // The last element is likely an incomplete line. Save it for the next chunk.
      leftover = lines.pop() || "";

      // 5. Parse the complete lines in this chunk
      const parsedRows = lines.map(line => parseCSVLine(line));
      rowCount += parsedRows.length;

      // 6. Send the batch of rows back to React immediately so memory stays low here
      self.postMessage({ type: 'BATCH', rows: parsedRows, totalSoFar: rowCount });
    }

    self.postMessage({ type: 'DONE', totalRows: rowCount });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error.message });
  }
};

/**
 * A basic CSV line parser. 
 * Handles simple commas. (For production, you'd add logic for quotes and escaped characters)
 */
function parseCSVLine(text) {
  // Simple split by comma. 
  // If your data has commas inside quotes, you'd use a regex or state machine loop here.
  return text.split(',');
}