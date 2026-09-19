# Cumulative CI blocker: exact-ceiling sideband relay

The current integration cohort exposed a repeatable hosted timeout in the exact50MiB sideband frame case. Initial campaign observation: #5152 run35435976658/macOS2 job105878594526, followed by devf39ba5aa run35436695398/macOS2 job105880533745. The latter reports one failure among13251passes, at the test's internal15s bound. Historical occurrence evidence is recorded in issue4997 comments5727773831 and5732577461; introductionPR1398 is separate history.

The relevant sideband test/relay/handler blobs are unchanged by physical-send accounting. That source trace separates the work scopes but does not dismiss the failed integration gate. Runtime owner owns a narrow diagnostic/repair branch; no duplicate repair exists in the reference integration task.

Keep the real50MiB bidirectional assertion, production limits and cancellation semantics. Use existing tests/helpers/phase-timing.ts to observe setup, ping, allocation/send, relay/upstream reception, echo and teardown. Always clear the inner timer and client in final cleanup. A diagnostic-only change is not proof the underlying timeout is fixed. Do not increase timeouts, skip platforms or delete assertions merely to get green.

Primary reference: [Bun WebSocket documentation](https://bun.com/docs/runtime/http/websockets), retrieved HTTP200 through the requested browser research surface on2026-09-19. It distinguishes server-side send backpressure, dropped messages and bytes sent. Instrument send result and drain/close state rather than equating a successful call with peer delivery. This server API distinction does not by itself explain the client-WebSocket relay delay or establish the pinned runtime's exact failure mechanism; hosted stage evidence remains required. No local runtime/probe/suite was executed.

Initial diagnostic96316e14 rejected beforepublication: phaseTimer had no probe/progressupdates and alwaysreported moving=no; ceilingphase conflatedallocation/send/relay/echo; earlyclose had noguard. Cleanup direction preserved, but comments claiming23s cause were unsupported. Owner is rebuilding with a focused helper and observable progress, preserving originalassertion/limits. Independent review confirms these findings; no diagnosticCI launched on inadequate evidence.

Rebuilt2a3b3a9 adds a boundedpeerprobe/helper and preserves50MiB/time/headerassertions. Beforehosteddiagnostics, review requires send-return boundary, earlyclose detection through finalACK and precise event-progress limits. Whole-eventcount cannot prove absenceofpartialtransfer. Mockserver sends a short byte-countACK ratherthan50MiBoutboundecho; documentation mustnameactualmeasurement. No runtimefailurefix claimed.

8d34fc77 passes independentdiagnosticreadinessreview: separateallocation/sendreturn/ACKwait, earlyclose untilfinalsuccess, milestone-onlyinterpretation, boundedprivacy-safeprobes and unchanged50MiB/15s/20s. Onehosteddiagnosticrun authorized. This approval is not rootcauseorperformancefixproof.

DiagnosticPR5161 published at8d34fc77 andattached, ordinarydevbase, explicitlyRelates4997 withoutclaimingafix. Exactheadhostedtiming evidence nowpending.

Firsthosteddiagnostic at8d34fc77/run35439343947 succeeded. macOS2: upgrade4.8ms,echo0.5ms,allocation49.7ms,synchronoussend20.3ms,ACKwait6039.4ms,total6220.25ms. One tickappearedat5927ms withoutnewmilestone beforecompletionprogress8. This localizesthatpassingrun toawait/relay/eventloopwindow, notallocation/send; itdoesnotexplainallpriorfailures orproveperformancefix. Finalreviewrequiresoutercleanupboundary include startServerstartupfailure soWebSocketoverride/mockcannotleak. Ownerreceivedcorrectionbeforemerge.

Startup-boundarycorrectione34aab04 fixes startServerthrowleak. Finalcleanupreviewrequests independentupstreamstop eveniflivestopthrows and movingphasecreationinsideclientcleanupscope. The latterisboundedhygiene, notanobservedruntimecause. Preserveexistingtimings/assertions; consolidatebeforefreshhostedrun.

Final1f0ab934 cleanupinterdiffPASS: clientphase/timerwithincleanupscope, proxyshutdownfailurestillattemptspeerstop, actualframe/headerassertions/privacy/limitsunchanged. FreshhostedCI authorized. Combinedwithindependentlygreen cumulative26d3runtime, landingtheseproveddiagnostics/cleanup willcompletecampaignintegration-recoverywork; broader4997performancecause remainsopenandisnotclaimedfixedornewunboundedoptimizationgoal.

Current1f0run35441351500 wascancelledatmacOS1job20mdeadline, after17m44sofnooutputinunchangedcodex-inject-write-lock.test.ts. Noassertionfailureprinted; sidebanddiffonlytest/helperandnotthatpath. Allotherproducerssucceeded. Afterinspectingrun/job/log/sourceequality andconfirmingnolivererun, coordinatorrequestedoneboundedjob-onlyrerun105892583094 withdependentaggregate. Recurrentstallrequiresdedicateddiagnosis,norepeatedblindrerunsorbudgetwidening. Cancelledattemptisnotapass.

## Delivered diagnostic and integration recovery

PR5161 MERGED asd1745ee7e8d2189e496f0d8ccdf3580a434791f0 at2026-09-19T12:40:33Z, exactreviewedhead1f0ab934. Currentattempt2 run35441351500 applicableproducers+aggregateSUCCESS, resolvedreviewthreads, maintainerpreflight/cleanunion/no-native-stack verified; actualdevancestryreread. FinalheadmacOSlog shows50MiBcasePASS6810.83ms withphaseevidence (allocation20.6ms,send106.2ms,ACKwait6509.5ms). Broader4997 remainsopen; diagnostic/cleanupdelivery+priorcumulativegreen closescampaignrecoverytaskwithoutclaiminggeneralperformancecausefixed.
