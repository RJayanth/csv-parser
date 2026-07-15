// VirtualList.tsx
import { useState, useEffect, type CSSProperties } from 'react';

interface VirtualListProps {
  height: number;
  itemCount: number;
  itemSize: number;
  overscanCount?: number;
  onItemsRendered: (info: { visibleStartIndex: number; visibleStopIndex: number }) => void;
  children: (props: { index: number; style: CSSProperties }) => React.ReactNode;
}

export default function VirtualList({
  height,
  itemCount,
  itemSize,
  overscanCount = 10,
  onItemsRendered,
  children,
}: VirtualListProps) {
  const [scrollTop, setScrollTop] = useState(0);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const totalHeight = itemCount * itemSize;
  
  // Calculate which rows are currently within the viewport (+ overscan buffer)
  const startIndex = Math.max(0, Math.floor(scrollTop / itemSize) - overscanCount);
  const endIndex = Math.min(itemCount - 1, Math.floor((scrollTop + height) / itemSize) + overscanCount);

  // Trigger data fetching whenever our viewport range changes
  useEffect(() => {
    onItemsRendered({ visibleStartIndex: startIndex, visibleStopIndex: endIndex });
  }, [startIndex, endIndex, onItemsRendered]);

  const visibleItems = [];
  for (let i = startIndex; i <= endIndex; i++) {
    visibleItems.push(
      children({
        index: i,
        style: {
          position: 'absolute',
          top: i * itemSize,
          left: 0,
          right: 0,
          height: itemSize,
        },
      })
    );
  }

  return (
    <div
      onScroll={handleScroll}
      style={{
        height,
        overflowY: 'auto',
        position: 'relative',
        width: '100%',
      }}
    >
      <div style={{ height: totalHeight, width: '100%', position: 'relative' }}>
        {visibleItems}
      </div>
    </div>
  );
}