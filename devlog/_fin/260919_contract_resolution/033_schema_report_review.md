# Initial tool-schema loss report review

Prepared commitdaae0ee29bf3246f95c7b49f5f5bda8aaf36f90f is the report-only first layer for #5112. It does not complete strict opt-in rejection or compatibility-repair reporting. Source/compiler/tests and documentation are reviewed separately.

Documentation review covered all18changed docs. Endpoint profiles, privacy boundaries, nativeoutput separation and no broaderdialect claims were accepted. Two corrections requested beforepublication: link/names for existing debug enable/read workflow and diagnosticrecord, and include version/lossy fields in the otherwise-exhaustive reportshape description across8locales. Source review pending; no localexecution or hostedpass claimed.

Core audit daae0ee2 FAIL: multi-type/unsupportedtype and omitted constraint keywords can change schemas while report remainslossyfalse; numericconst reachedthroughref canbe countedtwice; actualadapter integration matrix coversonlyone endpointmode. Coordinator verifiedcited sanitizerbranches and requested comprehensive bounded semanticloss accounting, exactlyonce refcounts and allthree adapterentry tests, preserving wirecompatibility/privacy/nativeoutput. Avoid unboundednewtraversal solelyforunknownkeywordreporting. No broaderdialect or completedstrictpolicy claim.

Report-only PR5162 published atdbdbc573 afterrebasingcurrentdev; corecorrectionchanges sanitizer/report tests, andfinalendpoint/docs claims underre-review. Docsfe39eb2f passed8locale discovery/payloadshapereview. Sourcepartialstage doesnotclose5112. CI/publication is not acceptanceproof.

Corecorrectiondbdbc573 re-review accepts previousmissingclassification/refdoublecount/realendpointmatrix fixes, boundedfixedkeywordprobes, unchangedwirebytes/nativeoutput. Remainingsemanticcategoryissue: a multi-type union collapsing toonesubtype narrowsacceptedvalues, so type-union-widened misdescribesit. Ownerasked torenamecollapsed/narrowed beforecontractestablished andkeepproseaccurate. No need changetransform.

Final6ce0819958 scopedrename/docsinterdiffPASS. Categorytype/emission/testexpectation agree; transform/compiler/adapter/registries unchanged; eightlocaleguides retainobservation-onlyprivacy/nativeoutput boundaries. CurrentheadCI pending. Owner may prepare auditedstrictpolicy manualchild onthishead, preservingparentandperPRproof; initialreport acceptance doesnotclose5112.

G1b roadmap revalidation after5155: all source-mapped docs remainreviewobligations, but oldplaninstructions toadd unchanged-boundaryprose everywhere are superseded. Ownerasked toeditactualcanonicalcontracts/affecteddependents and recordreviewed-unchanged evidence, preservingneededlocaleoperatorpolicy updates. Fullstrictconfig/initial/repairchain acceptance remainsunchanged.

Current6ce0819 had onlycancelledcontrolgate executions andno liveone; coordinator targetedlatest35439892314 forcontrol-onlyrerun. No runtime rerunorcancel requested. Current5161 successfulcontrolruns distinguishitsoldcancelledduplicates.

FinalGHreview raised newsemanticcases: anyOf canoverwrite siblingconstraintswithoutloss; referenceidentitycomparisonmislabels structurallyequivalentsiblings; inertdefault-valuedconstraints canbespuriouslylossy. Sentownerboundedcomparison/value-awarereportrequirementsandregressions; coreindependentvalidationpending. Strictchildmustinheritcorrectparentreport, withmanualcascadeandfreshproof. No diagnosticsorCIcoloroverrides theseacceptancegaps.

Independent5ea56 review confirms late-differinglargeenum counterexample: boundedcomparison returnsunknown beforedifference; schema-nodebudgetdoesnotcoverenumvalues; reporthasno uncertaintyflag andstrictchildadmitssilently. Ownerreceivedbounded explicituncertaintyreport/aggregation andstrictrefusalrequirement, withminimalnormalizedtype/enum/required equivalences. No fullJSONSchemaequivalence solver orwirebehaviorchange requested.

Parent76bbc600 introducesbounded uncertainComparisons count andaggregation pluscanonicalcomparisonchanges. Re-reviewassigned forcomparisonbudget/privacy/semanticaccuracy; strictchild mustexplicitlyrejectnonzero uncertainty beforedispatch. Currentpublicationdoesnotconstituteapproval.

76bbc parent implementationreview accepts explicitboundeduncertaintyandcanonicalcomparison. Requiredfinishinggaps: late-differing(notidentical) oversizedenumregression andparentdebugconsumer emittinguncertainty-onlyreports. Child11581 addsstrictlossy-or-uncertaincheck/typedindeterminateerror andisunderre-review. Parentmuststandalone exposeitsdiagnostics beforechildlands.

Parentenumreviewadjudication: target/overlayenumcomparisons mustconsiderdeclaredref+siblingintersection, notmerelyrawidentityorindependentfiltering. Exactnumericexcluded-by-overlayexampleislossless, whilenumericpresentinintersectionmustreportonceandwidenedoverlaystringsmustreport. Ownerasked boundedfocusedenumaccounting withuncertainty, preservingdefaultwirebehavior; nogeneralJSONschemaequivalencesolver.

cf4c59 enumintersection re-reviewPASS: requiredlossless/restrictive/numeric-exactonce matrix, boundedunknowncount andunchangedwire transformationverified. Strictchild374dada descendant/coreblobsunchanged. ActualcurrentheadhostedCI remainsrequired.

Four remaining parent review threads were answered with exact implementation evidence and resolved: anyOf sibling loss, structured/ref equality, enum intersection accounting, and docs-build proof. Hosted docs job105902238280/run35444918425 succeeded atcf4c59. No localbuild/install performed; current runtime/platform proof stillpending.

Parent #5162 merged as `8a030721b3ffc909ca7d8b05ca0b7c873c1493a1` at 2026-09-19T13:48:19Z. Head `cf4c59bd5f2002d9df9f9427843701451c36fb1e` passed all applicable hosted jobs and aggregate in [35444918425](https://github.com/lidge-jun/opencodex/actions/runs/35444918425), plus target enforcement35444917556. Current maintainer identity/base/head, empty native-stack membership, no unresolved threads or maintainer objections, and clean merge-tree were checked. Refreshed origin/dev contains the merge. #5112 remains open because strict-policy child #5167 has not landed. Parent branch retained; child owner requested to retarget/restack and obtain fresh exact-head proof.
