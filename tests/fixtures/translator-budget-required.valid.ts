import type { ProviderAdapter } from "../../src/adapters/base";
import type { CursorTransportFactoryInput } from "../../src/adapters/cursor/transport";
import type { OcxParsedRequest } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

declare const adapter: ProviderAdapter;
declare const parsed: OcxParsedRequest;
declare const response: Response;
declare const emit: Parameters<NonNullable<ProviderAdapter["runTurn"]>>[2];
const translatorBudget = createTestTranslatorBudget();
const incoming = { headers: new Headers(), translatorBudget };

void adapter.buildRequest(parsed, incoming);
void adapter.parseStream(response, translatorBudget);
void adapter.parseResponse?.(response, translatorBudget);
void adapter.runTurn?.(parsed, incoming, emit);
const cursorInput: CursorTransportFactoryInput = {
  provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh" },
  translatorBudget,
};
void cursorInput;
translatorBudget.dispose();
