import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface Props {
  opcion: echarts.EChartsCoreOption;
  alturaPx?: number;
  minAnchoPx?: number;
  ariaLabel: string;
  onClickElemento?: (params: echarts.ECElementEvent) => void;
}

export const LienzoECharts: React.FC<Props> = ({
  opcion,
  alturaPx = 340,
  minAnchoPx,
  ariaLabel,
  onClickElemento,
}) => {
  const contenedorRef = useRef<HTMLDivElement | null>(null);
  const instanciaRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = contenedorRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    instanciaRef.current = chart;

    const observador =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            chart.resize();
          })
        : null;
    observador?.observe(el);

    return () => {
      observador?.disconnect();
      chart.dispose();
      instanciaRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = instanciaRef.current;
    if (!chart) return;
    chart.setOption(opcion, true);
  }, [opcion]);

  useEffect(() => {
    const chart = instanciaRef.current;
    if (!chart) return;
    chart.off('click');
    if (onClickElemento) {
      chart.on('click', (params) => {
        onClickElemento(params as echarts.ECElementEvent);
      });
    }
  }, [onClickElemento]);

  return (
    <div
      style={{
        width: '100%',
        overflowX: minAnchoPx ? 'auto' : 'hidden',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div
        ref={contenedorRef}
        role="img"
        aria-label={ariaLabel}
        style={{
          width: '100%',
          minWidth: minAnchoPx ? `${minAnchoPx}px` : undefined,
          height: `${alturaPx}px`,
        }}
      />
    </div>
  );
};
