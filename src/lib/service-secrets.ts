import { join } from "node:path";
import { getConfigDir } from "../config";

export function serviceApiTokenFilePath(): string {
  return join(getConfigDir(), "service-api-token");
}
