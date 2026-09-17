import type { ZeroxFirmQuote } from "../types.js";
import type { QuoteSigningTask } from "../signing.js";

export function getZeroxSigningTasks(quote: ZeroxFirmQuote): QuoteSigningTask[] {
  const tasks: QuoteSigningTask[] = [];
  if (quote.approval) {
    tasks.push({
      venue: "zerox",
      kind: "approval",
      typedData: quote.approval.eip712,
    });
  }
  const typedData = quote.toSign ?? quote.trade?.eip712;
  if (!typedData) throw new Error("0x quote is missing trade typed data");
  tasks.push({ venue: "zerox", kind: "trade", typedData });
  return tasks;
}
