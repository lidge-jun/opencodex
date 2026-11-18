import { normalizeMessagesProxyRefusal } from "../lib/messages-error-body";
import { withCors, type RequestPolicyView } from "./auth-cors";
import { runAdmittedBodyWork } from "./inbound-body-admission";
import { tryAdmitTurn, type ActiveTurnLease } from "./lifecycle";
import { addFinalRequestLog } from "./request-log";
import { requestBodyFactsHolder } from "./request-body-facts";
import { sessionLaneIdFromRequest } from "./request-log-conversation";
import { admitHttpWorkflowTurn, workflowDecisionRefusalResponse, type WorkflowRefusalLog } from "./workflow-refusal";

export interface AdmittedHttpTurnOptions {
  mapRefusal?: (response: Response) => Response;
  onAdmissionError?: (error: unknown) => Response;
}

export function createAdmittedHttpTurn(
  configuredLimit: () => number | undefined,
  serverBusyResponse: (req: Request, resource: string, policy: RequestPolicyView) => Response,
) {
  return async function runAdmittedHttpTurn(
    req: Request,
    policy: RequestPolicyView,
    work: (lease: ActiveTurnLease) => Promise<Response>,
    refusalLog?: WorkflowRefusalLog,
    options?: AdmittedHttpTurnOptions,
  ): Promise<Response> {
    const map = (response: Response) => options?.mapRefusal ? options.mapRefusal(response) : response;
    // The row carries the size and encoding of the body this turn's handler reads from `req` (#3023).
    if (refusalLog) refusalLog.logCtx.requestBodyHolder ??= requestBodyFactsHolder(req);
    const lease = tryAdmitTurn(sessionLaneIdFromRequest(req.headers), req.signal);
    if (!lease) {
      const response = serverBusyResponse(req, "active turns", policy);
      return options?.mapRefusal ? withCors(map(response), req, policy) : response;
    }
    let workflow: ReturnType<typeof admitHttpWorkflowTurn>;
    try { workflow = admitHttpWorkflowTurn(req.headers); }
    catch (error) { lease.release(); throw error; }
    if (workflow && !workflow.admitted) {
      lease.release();
      return withCors(await normalizeMessagesProxyRefusal(req, map(workflowDecisionRefusalResponse(workflow, undefined, refusalLog))), req, policy);
    }
    if (workflow?.admitted) lease.attach(workflow.lease);
    try {
      const response = await runAdmittedBodyWork(req, policy, configuredLimit(), () => work(lease), refusalLog,
        options?.mapRefusal, options?.onAdmissionError ? error => {
          if (!req.signal.aborted || error !== req.signal.reason) throw error;
          lease.release();
          if (refusalLog) {
            addFinalRequestLog(refusalLog.requestId, refusalLog.start, refusalLog.logCtx, 499, { closeReason: "client_cancel" });
            refusalLog.onLogged?.();
          }
          return withCors(map(options.onAdmissionError!(error)), req, policy);
        } : undefined);
      if (!lease.isTransferred()) lease.release();
      return response;
    } catch (error) {
      lease.release();
      throw error;
    }
  };
}
