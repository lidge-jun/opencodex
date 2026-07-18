/**
 * Tree-shaken ECharts surface for the Frontier page (avoid full echarts bundle).
 */
import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  ScatterChart,
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkPointComponent,
  CanvasRenderer,
]);

export default echarts;
