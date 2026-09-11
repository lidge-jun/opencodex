// Vietnamese locale; technical terms and model identifiers intentionally remain English.
// Strings with {cmd} render a <code> chip via <Trans>; {var} are plain interpolations.
/**
 * English i18n catalog — source of truth. Its keys define the compile-checked `TKey` set;
 * other locales must match (compile-checked). `{cmd}` renders a <code> chip via <Trans>;
 * `{var}` are plain interpolations.
 */
export const vi: Record<import("./en").TKey, string> = {
  "models.pickerOrder.label": "Thứ tự chọn",

  "models.pickerOrder.default": "Mặc định",
  "models.pickerOrder.alphabetical": "A–Z theo model",

  "models.pickerOrder.provider": "Nhóm theo provider",

  "models.pickerOrder.mostUsed": "Bản chụp dùng nhiều nhất",

  "models.pickerOrder.custom": "Thứ tự tuỳ chỉnh",

  "models.pickerOrder.apply": "Áp dụng thứ tự",

  "models.pickerOrder.applying": "Đang áp dụng…",
  "models.pickerOrder.saved": "Đã lưu thứ tự chọn. Hãy mở lại các client vẫn hiển thị catalog cũ.",

  "models.pickerOrder.pending": "Đã lưu thứ tự; đang chờ làm mới catalog.",

  "models.pickerOrder.usageFailed": "Không thể tải mức sử dụng model.",

  "models.pickerOrder.loadFailed": "Không thể tải cài đặt bộ chọn.",

  "models.pickerOrder.retry": "Thử lại",
  "models.pickerOrder.hint": "Lưu thứ tự được định tuyến cho việc khám phá của Codex và Claude. Các dải native/được giới thiệu giữ nguyên vị trí; 'Bản chụp dùng nhiều nhất' là một bản chụp (snapshot). Các lựa chọn native được quảng cáo có thể thay đổi.",

  "codexAuth.quotaAutoRefreshAllHint": "Điều khiển các khung thời gian 5 giờ và hàng tuần được hỗ trợ cho tất cả các tài khoản hiện tại cùng lúc. Ở chế độ Pool, một yêu cầu nhỏ sẽ được gửi đi sau mỗi lần đặt lại và có tiêu tốn hạn ngạch.",

  "codexAuth.quotaAutoRefreshMixed": "Một số khung thời gian đã được bật.",

  "codexAuth.quotaAutoRefreshEmpty": "Không có khung thời gian hạn ngạch nào được hỗ trợ. Hãy làm mới hạn ngạch tài khoản để kiểm tra lại.",

  "codexAuth.quotaAutoRefreshLoadFailed": "Không thể tải các cài đặt kích hoạt. Hãy thử lại để kiểm tra trạng thái của chúng.",

  "codexAuth.quotaAutoRefreshPartial": "Không thể lưu một số cài đặt. Hãy thử lại để hoàn tất cùng một thay đổi.",

  // sidebar / nav / common
  "nav.dashboard": "Bảng điều khiển",
  "uptime.day": "ng",

  "uptime.hour": "g",

  "uptime.minute": "p",

  "uptime.second": "g",

  "nav.startup": "Khởi động",

  "nav.providers": "Nhà cung cấp",
  "nav.models": "Models",

  "nav.combos": "Combos",

  "nav.subagents": "Subagents",

  "nav.logs": "Logs & Gỡ lỗi",

  "nav.usage": "Mức sử dụng",
  "common.github": "GitHub",

  "sidebar.star": "Gắn sao trên GitHub",

  "sidebar.starred": "Đã gắn sao trên GitHub",

  "sidebar.starUnauthenticated": "Mở GitHub để gắn sao (CLI gh chưa đăng nhập)",

  "sidebar.starFailed": "Không thể gắn sao qua gh. Thay vào đó sẽ mở GitHub.",

  "sidebar.updateAvailable": "Bản cập nhật có sẵn: {version}",

  "sidebar.checkUpdate": "Kiểm tra bản cập nhật",

  "common.save": "Lưu",
  "common.saving": "Đang lưu…",

  "common.cancel": "Hủy",
"common.discard": "Huỷ bỏ",

  "common.delete": "Xóa",
  "common.close": "Đóng",
  "common.ok": "OK",

  "common.remove": "Xóa",
  "common.loading": "Đang tải…",
  "common.retry": "Thử lại",
  "auth.adminTokenTitle": "Token quản trị OpenCodex (OPENCODEX_ADMIN_AUTH_TOKEN)",

  "auth.adminAccountLabel": "Tài khoản",
  "auth.adminTokenFieldLabel": "Token quản trị",

  "auth.adminTokenRejected": "Token quản trị đó đã bị từ chối. Hãy kiểm tra lại và thử lại.",

  "auth.adminTokenUnavailable": "Không thể xác minh token quản trị. Hãy thử lại.",

  "auth.adminTokenHelp": "Đây là token quản trị quản lý OpenCodex, không phải là API key của provider. Proxy ghi nó vào ~/.opencodex/admin-api-token (hoặc $OPENCODEX_HOME/admin-api-token) trong lần khởi động đầu tiên và OPENCODEX_ADMIN_AUTH_TOKEN sẽ ghi đè nó.",

  "auth.adminTokenDocsLink": "Cách tìm nó",

  "app.logoAria": "logo opencodex",

  "app.claudeOn": "Claude BẬT",

  "app.claudeOff": "Claude TẮT",

  "theme.label": "Giao diện",
  "theme.light": "Sáng",
  "theme.dark": "Tối",
  "theme.system": "Hệ thống",
  "lang.label": "Ngôn ngữ",
  "lang.nativeName": "Tiếng Việt",
  "provider.name.commandCodeAuth": "Command Code - Auth",

  "provider.name.commandCodeApi": "Command Code - API",

  "provider.name.orcaRouterApi": "OrcaRouter - API",

  "provider.name.orcaRouterAuth": "OrcaRouter - Auth",

  "provider.name.volcengine": "Volcengine Ark",

  "provider.name.volcengineCodingPlan": "Volcengine Ark Coding Plan",

  "provider.name.volcengineAgentPlan": "Volcengine Ark Agent Plan",

  "errorBoundary.title": "Không thể tải trang",

  "errorBoundary.message": "Phần này gặp lỗi kết xuất. Hãy tải lại trang để thử lại.",

  "errorBoundary.details": "Lỗi",
  "errorBoundary.reload": "Tải lại",


  // routing intelligence
  "routing.title": "Định tuyến thông minh (beta)",

  "routing.subtitle": "Hồ sơ chính sách, đánh giá chạy thử (dry-run) và phân tích định tuyến dựa trên nguồn.",

  "routing.loadFailed": "Không thể tải dữ liệu định tuyến",

  "routing.empty": "Không có hồ sơ định tuyến nào được định cấu hình. Hãy thêm `routingProfiles` vào config.json.",

  "routing.revision": "rev",

  "routing.detail": "Hồ sơ",

  "routing.createProfile": "Tạo hồ sơ",

  "routing.dryRunError": "Chạy thử (dry-run) thất bại (HTTP {status})",

  "routing.removeConfirm": "Xóa hồ sơ {id}?",

  "routing.unknownEvidence.allow": "cho phép",

  "routing.unknownEvidence.penalize": "phạt",

  "routing.unknownEvidence.exclude": "loại trừ",

  "routing.removeCandidate": "Xóa ứng viên {provider}/{model}",

  "routing.candidates": "Ứng viên",

  "routing.require": "Yêu cầu bắt buộc",

  "routing.optimize": "Trọng số tối ưu hóa",

  "routing.limits": "Giới hạn",

  "routing.unknownEvidence": "Chính sách bằng chứng không xác định",

  "routing.compatibility.title": "Chính sách tương thích",

  "routing.compatibility.enabled": "Yêu cầu bằng chứng từ Compatibility Lab",

  "routing.compatibility.requiredSuites": "Các suite bắt buộc",

  "routing.compatibility.loadingCatalog": "Đang tải catalog của lab…",

  "routing.compatibility.catalogUnavailable": "Catalog của lab không khả dụng — hãy nhập thủ công các id suite trong config.json.",

  "routing.compatibility.layer.protocol_conformance": "Tuân thủ giao thức",

  "routing.compatibility.layer.live_route_compatibility": "Tương thích định tuyến trực tiếp",

  "routing.compatibility.minStatus": "Trạng thái tương thích tối thiểu",

  "routing.none": "không có",

  "routing.unavailable": "–",
  "routing.dryRun": "Đánh giá chạy thử (dry-run)",

  "routing.dryRunContext": "Cửa sổ ngữ cảnh yêu cầu (tokens)",

  "routing.dryRunTools": "Yêu cầu có các công cụ",

  "routing.dryRunImage": "Yêu cầu có đầu vào hình ảnh",

  "routing.dryRunStructured": "Yêu cầu có đầu ra có cấu trúc",

  "routing.dryRunRun": "Đánh giá các ứng viên",

  "routing.candidate": "Ứng viên",

  "routing.eligible": "Đủ điều kiện",

  "routing.exclusions": "Loại trừ",

  "routing.costCap": "Giới hạn chi phí",

  "routing.capOutcome.satisfied": "trong giới hạn",

  "routing.capOutcome.exceeded": "vượt giới hạn",

  "routing.capOutcome.unknown-allowed": "không xác định (cho phép)",

  "routing.capOutcome.unknown-excluded": "không xác định (loại trừ)",

  "routing.exclusion.capability-unsatisfied": "không đáp ứng khả năng",

  "routing.exclusion.unknown-capability": "khả năng không xác định",

  "routing.exclusion.cost-limit": "vượt giới hạn chi phí",

  "routing.exclusion.cost-limit-unknown": "chi phí không xác định dưới giới hạn",

  "routing.exclusion.cooldown": "thời gian hồi",

  "routing.exclusion.unknown-health": "trạng thái sức khoẻ không xác định",

  "routing.exclusion.unknown-quota": "hạn ngạch không xác định",

  "routing.exclusion.unknown-price": "giá không xác định",

  "routing.exclusion.other": "loại trừ: {code}",

  "routing.score": "Điểm",

  "routing.selected": "đã chọn",

  "routing.yes": "có",

  "routing.no": "không",

  "routing.analytics": "Phân tích định tuyến",

  "routing.analyticsTotal": "Yêu cầu",

  "routing.analyticsSuccessRate": "Thành công",
  "routing.analyticsFallbackRate": "Dự phòng",

  "routing.analyticsP50": "p50",

  "routing.analyticsP95": "p95",

  "routing.analyticsP99": "p99",

  "routing.analyticsCooldown": "Lỗi cooldown",

  "routing.analyticsConfidence": "Độ tin cậy",

  "routing.analyticsTruncated": "lịch sử bị cắt bớt",

  "routing.analyticsRequests": "Yêu cầu",

  "routing.analyticsEmpty": "Chưa có phân tích nào — hãy gửi vài yêu cầu trước.",


  // startup health
  "startup.title": "An toàn khởi động",

  "startup.subtitle": "Xác minh rằng Codex có thể kết nối với opencodex sau khi khởi động lại, trước khi proxy định tuyến cục bộ trở thành một vòng lặp kết nối lại.",

  "startup.refresh": "Làm mới",
  "startup.backToDashboard": "Quay lại Bảng điều khiển",

  "startup.loading": "Đang kiểm tra bảo vệ khởi động…",

  "startup.error": "Không thể đọc bảo vệ khởi động.",

  "startup.staleData": "Lần kiểm tra khởi động gần nhất thất bại. Các giá trị bên dưới đã cũ và không được coi là bằng chứng bảo vệ.",

  "startup.status.native": "Định tuyến native",

  "startup.status.protected": "Bảo vệ khi khởi động lại",

  "startup.status.atRisk": "Cần hành động",

  "startup.summary.native": "Codex không phụ thuộc vào proxy cục bộ",

  "startup.summary.protected": "opencodex sẽ khả dụng sau khi khởi động lại",

  "startup.summary.atRisk": "Codex có thể mất kết nối model sau khi khởi động lại",

  "startup.riskDetail": "Codex được ghim vào proxy cục bộ, nhưng không có service nền hoặc launcher shim khoẻ mạnh nào sẽ khởi động lại nó.",

  "startup.riskDetailCustomLocal": "Codex trỏ đến một cổng cục bộ (custom local gateway) tùy chỉnh. opencodex không thể quản lý hoặc xác minh vòng đời khởi động lại của cổng đó.",

  "startup.riskDetailWindowsShim": "Launcher shim bảo vệ các tập lệnh CLI được hỗ trợ, nhưng Codex Desktop và các lần khởi chạy codex.exe trực tiếp có thể bỏ qua nó trên Windows.",

  "startup.safeDetail": "Cơ chế định tuyến và khởi động hiện tại đã nhất quán. Sẽ không cần phải khởi động ocx thủ công sau khi khởi động lại.",

  "startup.routing": "Định tuyến Codex",

  "startup.routing.proxy": "Proxy cục bộ",

  "startup.routing.native": "OpenAI gốc",

  "startup.routing.customLocal": "Gateway cục bộ tuỳ chỉnh",

  "startup.routing.customRemote": "Gateway từ xa tuỳ chỉnh",

  "startup.routing.unknown": "Định tuyến không xác định hoặc không hợp lệ",

  "startup.restartProtection": "Bảo vệ khởi động lại",

  "startup.preference": "Khởi động theo yêu cầu",

  "startup.enabled": "Đã bật",
  "startup.disabled": "Đã tắt",
  "startup.protection.service": "Service nền",

  "startup.protection.shim": "Trình bao bọc khởi chạy",

  "startup.protection.none": "Chưa cài đặt",

  "startup.details": "Chi tiết bảo vệ",

  "startup.service": "Service nền",

  "startup.serviceHint": "Khởi chạy lúc đăng nhập và khởi động lại proxy sau khi bị sự cố.",

  "startup.installed": "Đã cài đặt",

  "startup.notInstalled": "Chưa cài đặt",

  "startup.unsupported": "Không hỗ trợ",

  "startup.shim": "Trình bao bọc khởi chạy Codex",

  "startup.shimHint": "Chạy ocx ensure khi một trình khởi chạy tập lệnh Codex được hỗ trợ bắt đầu.",

  "startup.healthy": "Khoẻ mạnh",

  "startup.cliOnly": "Chỉ dành cho CLI",

  "startup.stale": "Đã cũ",

  "startup.viable": "Sẵn sàng",

  "startup.unhealthy": "Đã cài đặt nhưng không khoẻ mạnh",

  "startup.conflict": "Xung đột service",

  "startup.installedDisabled": "Đã cài đặt nhưng bị vô hiệu hoá",

  "startup.install": "Cài đặt",

  "startup.installing": "Đang cài đặt…",

  "startup.repair": "Sửa chữa",

  "startup.repairing": "Đang sửa chữa…",

  "startup.serviceInstalled": "Service nền đã được cài đặt thành công.",

  "startup.serviceRepaired": "Service nền đã được sửa chữa thành công.",

  "startup.shimInstalled": "Codex launcher shim đã được cài đặt thành công.",

  "startup.shimRepaired": "Codex launcher shim đã được sửa chữa thành công.",

  "startup.installFailed": "Cài đặt thất bại:",

  "startup.tray.title": "Khay hệ thống Windows",

  "startup.tray.hint": "Cài đặt biểu tượng khay khi đăng nhập để khởi động, dừng, khởi động lại, mở bảng điều khiển và kiểm soát trạng thái proxy chỉ bằng một cú nhấp chuột.",

  "startup.tray.login": "Bắt đầu khay hệ thống khi đăng nhập Windows",

  "startup.tray.notProtection": "Khay hệ thống là một bộ điều khiển, không phải là tính năng bảo vệ khởi động lại. Một service nền khả thi vẫn cần thiết để phục hồi proxy tự động.",

  "startup.tray.running": "Đang chạy",

  "startup.tray.stopped": "Đã cài đặt, bị ẩn",

  "startup.tray.stale": "Cần sửa chữa",

  "startup.tray.notInstalled": "Chưa cài đặt",

  "startup.tray.loading": "Đang kiểm tra…",

  "startup.tray.unavailable": "Trạng thái không khả dụng",

  "startup.tray.install": "Cài đặt và hiển thị khay hệ thống",

  "startup.tray.start": "Hiển thị biểu tượng khay hệ thống",

  "startup.tray.stop": "Thoát biểu tượng khay hệ thống",

  "startup.tray.uninstall": "Gỡ biểu tượng khay hệ thống",

  "startup.tray.error": "Hành động trên khay hệ thống Windows đã thất bại. Vui lòng kiểm tra trạng thái ocx tray để biết chi tiết.",

  "startup.recovery": "Các tuỳ chọn sửa chữa",

  "startup.recoveryHint": "Sử dụng các trình cài đặt một click ở trên, hoặc sao chép lệnh để sửa chữa thủ công. Service nền được khuyến nghị dùng cho Codex Desktop và các tệp thực thi Windows.",

  "startup.command.service": "Khuyên dùng: service nền bền bỉ",

  "startup.command.shim": "Tuỳ chọn thay thế: launcher shim cho CLI",

  "startup.command.native": "An toàn dự phòng (Fail-safe): khôi phục định tuyến native cho Codex",

  "startup.copy": "Sao chép",
  "startup.copied": "Đã sao chép",
  "startup.recommended": "Sửa chữa được đề xuất: {cmd}",

  "startup.navRisk": "Bảo vệ khởi động cần sự chú ý",

  "startup.codexRuntime.clampHidden": "Một số tùy chọn effort suy luận đã bị ẩn do OpenCodex đang sử dụng Codex {version}.",

  "startup.codexRuntime.clampHiddenWithEfforts": "Một số tùy chọn effort suy luận đã bị ẩn do OpenCodex đang sử dụng Codex {version} (đã gỡ: {efforts}).",

  "startup.codexRuntime.olderBinary": "OpenCodex đang sử dụng một tệp nhị phân Codex cũ hơn ({version}). Có một bản cài đặt mới hơn khả dụng.",


  // dashboard
  "dash.subtitle": "Trạng thái trực tiếp của opencodex proxy cục bộ, các providers của nó và các models được định tuyến vào Codex.",

  "dash.workspace.overview": "Tổng quan",
  "dash.workspace.sections": "Các phần",

  "dash.status": "Trạng thái",
  "dash.online": "Trực tuyến",
  "dash.offline": "Ngoại tuyến",
  "dash.version": "Phiên bản",

  "dash.uptime": "Thời gian hoạt động",

  "dash.providers": "Nhà cung cấp",
  "dash.tokens30d": "Tokens (30 ngày)",

  "dash.coverage": "{pct} độ phủ",

  // memory observability card (read-only /api/system/memory)
  "dash.mem.title": "Khả năng quan sát bộ nhớ",

  "dash.mem.hint": "Chẩn đoán runtime chỉ đọc. Bộ nhớ được quan sát là max(RSS, external, ArrayBuffers) nên việc Windows xén bộ nhớ làm việc không che giấu mức giữ bộ nhớ đã cấp phát.",

  "dash.mem.rss": "Tập hợp thường trú (RSS)",

  "dash.mem.jsHeap": "JS heap đang dùng",

  "dash.mem.jsHeapArena": "vùng {total}",

  "dash.mem.pressure": "So với ngưỡng cảnh báo",

  "dash.mem.pressureOf": "{pct}% của ngưỡng",

  "dash.mem.pressureUnknown": "Chưa báo cáo ngưỡng",

  "dash.mem.jscHeap": "Heap JSC",

  "dash.mem.external": "Bên ngoài",

  "dash.mem.arrayBuffers": "ArrayBuffers",

  "dash.mem.observed": "Đã quan sát",

  "dash.mem.runtime": "Bộ đếm thời gian chạy",

  "dash.mem.growth": "Sự sai lệch (drift) / giờ đã quan sát",

  "dash.mem.perHour": "/g",

  "dash.mem.store": "Lưu trữ phần tiếp nối (Continuation store)",

  "dash.mem.storeHint": "Bộ đệm previous_response_id của proxy. Tổng byte tăng dần dưới một heap đang tăng chỉ ra rằng nguyên nhân là do giữ lại các cuộc hội thoại thay vì từ trình cấp phát thời gian chạy.",

  "dash.mem.storeEntries": "Mục nhập",

  "dash.mem.storeTotal": "Tổng cộng",

  "dash.mem.storeLargest": "Lớn nhất",

  "dash.mem.storeOldest": "Cũ nhất",

  "dash.mem.threshold": "Ngưỡng cảnh báo",

  "dash.mem.lastWarn": "Cảnh báo cuối cùng",

  "dash.mem.never": "Không bao giờ",
  "dash.mem.details": "Chi tiết",
  "dash.mem.unavailable": "Chẩn đoán bộ nhớ không khả dụng (proxy phiên bản cũ hơn).",

  "dash.mem.inFlight": "Các yêu cầu đang xử lý (In-flight requests)",

  "dash.mem.restart": "Xả & khởi động lại",

  "dash.mem.restartConfirm": "Chờ {count} yêu cầu đang xử lý, sau đó khởi động lại (tối đa {seconds} giây; các yêu cầu còn lại sẽ bị ngắt khi hết thời gian).",

  "dash.mem.draining": "Đang xả {count} yêu cầu… sẽ khởi động lại khi hoàn tất",

  "dash.mem.reconnecting": "Proxy đang khởi động lại… đang đợi kết nối lại",

  "dash.mem.restartFailed": "Xả & khởi động lại thất bại. Vui lòng kiểm tra xem proxy có đang chạy không.",

  "dash.mem.restartNoSupervisor": "Không phát hiện thấy bảo vệ khởi động lại. Proxy có thể vẫn ngừng hoạt động sau khi khởi động lại trừ khi bạn khởi động lại nó.",

  "dash.activeProviders": "Các provider đang hoạt động",

  "dash.noProviders": "Chưa có provider nào được cấu hình. Hãy chạy {cmd}.",

  "dash.col.name": "Tên",
  "dash.col.adapter": "Adapter",

  "dash.col.baseUrl": "Base URL",

  "dash.col.model": "Model",

  "dash.modelsNoResults": "Không có models nào khớp với tìm kiếm của bạn.",

  "dash.availableModels": "Models khả dụng",

  "dash.noModels": "Không tìm thấy models. Hãy kiểm tra các API keys của provider.",

  "dash.cannotConnect": "Không thể kết nối đến proxy. Có phải nó đang chạy?",

  "dash.runStart": "Chạy {cmd} để khởi động proxy.",

  "dash.stop": "Dừng Proxy",

  "dash.stopConfirm": "Dừng proxy và khôi phục native Codex?",

  "dash.stopFailed": "Không thể dừng proxy (HTTP {status}).",

  "dash.maSwitchFailed": "Chuyển đổi chế độ thất bại (HTTP {status}).",

  "dash.maNetworkError": "Lỗi mạng — có phải proxy đang chạy không?",

  "dash.stopping": "Đang dừng…",

  "dash.actions": "Proxy",

  "dash.codexRestart": "Tải lại các models của Codex",

  "dash.codexRestarting": "Đang dừng…",

  "dash.codexRestartConfirm": "Dừng app-servers của Codex để chúng tải lại danh sách model? Bất kỳ lượt chạy Codex nào đang tiến hành sẽ bị gián đoạn và Codex không tự khởi chạy lại — bạn cần mở lại nó sau đó.",

  "dash.codexRestartDone": "Đã dừng {count} app-server(s) của Codex. Hãy mở lại Codex để tải danh sách model hiện tại.",

  "dash.codexRestartNothing": "Không có app-server Codex nào đang chạy. Lần khởi chạy tiếp theo sẽ đọc danh sách model hiện tại.",

  "dash.codexRestartUnknown": "Không thể liệt kê các tiến trình, do đó không có gì bị dừng.",

  "dash.codexRestartPartial": "{count} app-server(s) đã không thoát. Hãy dừng chúng thủ công nếu danh sách model vẫn còn cũ.",

  "dash.codexRestartFailed": "Không thể tải lại các models của Codex (HTTP {status}).",

  "dash.codexRestartUnreachable": "Không thể kết nối với proxy.",

  "dash.codexRestartMalformed": "Proxy trả về phản hồi không mong đợi.",

  "dash.codexRestartTimeout": "Proxy không phản hồi đúng thời gian. Nó có thể vẫn đang dừng các app-servers.",

  "models.staleBanner": "Codex đang hiển thị danh sách model cũ hơn so với catalog này. Hãy khởi động lại Codex để tải lại.",

  "dash.codexAutoStart": "Khởi động opencodex cùng với Codex",

  "dash.codexAutoStartHint": "Cho phép launcher shim đã cài đặt chạy ocx ensure. Cài đặt này không cài đặt bảo vệ khởi động lại; vui lòng kiểm tra tính năng an toàn khởi động để biết trạng thái hiệu lực.",

  "dash.searchModel": "Sidecar model tìm kiếm",

  "dash.searchModelHint": "Model được sử dụng cho tính năng web_search trên các models định tuyến không thuộc OpenAI. Yêu cầu đăng nhập ChatGPT.",

  "dash.searchReasoning": "Mức độ lý luận tìm kiếm (reasoning effort)",

  "dash.visionModel": "Sidecar model hình ảnh (vision)",

  "dash.visionModelHint": "Model được sử dụng để mô tả hình ảnh cho các model định tuyến chỉ hỗ trợ văn bản. Yêu cầu đăng nhập ChatGPT.",

  "dash.webSearchSidecar": "Web search sidecar",

  "dash.webSearchSidecarHint": "Chọn backend và model được sử dụng cho tìm kiếm web trên các models định tuyến.",

  "dash.webSearchStream": "Phát trực tuyến (Stream) các câu trả lời trực tiếp",

  "dash.webSearchStreamHint": "Phát trực tuyến các văn bản dẫn dắt và quá trình lý luận của model cho đến khi nó quyết định gọi một công cụ; phần còn lại của lượt chạy sẽ được lưu đệm (buffered) để can thiệp tìm kiếm. Văn bản được viết trước một tìm kiếm có thể lặp lại một phần.",

  "dash.visionSidecar": "Vision sidecar",

  "dash.visionSidecarHint": "Chọn backend và model được sử dụng để mô tả hình ảnh cho các model định tuyến chỉ hỗ trợ văn bản.",

  "dash.visionOff": "Tắt",

  "dash.visionAdvanced": "Cài đặt nâng cao",

  "dash.visionMaxDescriptions": "Số lượng mô tả tối đa mỗi lượt",

  "dash.visionMaxDescriptionsInvalid": "Vui lòng nhập một số nguyên dương.",

  "dash.visionTimeout": "Thời gian chờ (Timeout)",

  "dash.visionTimeoutInvalid": "Vui lòng nhập một số nguyên từ {min} đến {max} milliseconds.",

  "dash.visionAdvancedPopover": "Cài đặt vision nâng cao",

  "dash.shadowCallIntercept": "Shadow Call Intercept",

  "dash.shadowCallInterceptHint": "Chặn các lệnh gọi helper nền ({models}) của ứng dụng Codex để tạo tiêu đề và commit messages, sau đó chuyển hướng chúng đến model bạn đã chọn.",

  "dash.shadowCallWarning": "⚠ Khi được bật, TẤT CẢ yêu cầu đối với {models} sẽ được thay thế bằng model được chọn.",

  "dash.shadowCallOriginal": "Gốc",

  "dash.shadowCallModel": "Model thay thế",

  "dash.shadowCallTooltip": "Ứng dụng Codex thực hiện các lệnh gọi helper ngầm để tạo tiêu đề chuỗi, tạo commit message và điều phối các kĩ năng. Helper model có thể thay đổi giữa các phiên bản client, do đó opencodex chặn mọi model trong tập hợp này: {models}. Hãy bật tính năng này để chuyển hướng các lệnh gọi đó đến model bạn chọn.",

  "models.shadowCallIntercept": "Shadow Call Intercept",

  "models.shadowCallInterceptHint": "Chặn các lệnh gọi helper nền ({models}) của ứng dụng Codex để tạo tiêu đề và commit messages, và chuyển hướng chúng đến model bạn chọn.",

  "dash.sidecarBackend": "Backend",

  "dash.sidecarModel": "Model",

  "dash.backendAuto": "Tự động",

  "dash.backendOpenAI": "OpenAI",

  "dash.backendAnthropic": "Anthropic",

  "dash.sidecarSaved": "Cài đặt sidecar đã được lưu. Sẽ được áp dụng trong yêu cầu tiếp theo.",

  "dash.sidecarSaveFailed": "Lưu cài đặt sidecar thất bại.",

  "dash.injectionLabel": "Ủy quyền sub-agent",

  "dash.injectionHint": "Chọn model mà Codex sẽ dùng để giao công việc cho các sub-agents. Hai tuỳ chọn bên dưới sẽ quyết định nơi sử dụng lựa chọn này.",

  "dash.injectionManage": "Mở cài đặt",

  "dash.syncCodexSubagentDefaults": "Đồng thời lưu dưới dạng cài đặt mặc định của Codex",

  "dash.syncCodexSubagentDefaultsHint": "Khi Bật, lựa chọn ở trên sẽ được ghi vào cấu hình riêng của Codex, để các tác vụ mới cũng bắt đầu với model đó. Khi Tắt, nó chỉ được ghi nhớ ở đây. Cài đặt này có hiệu lực ở lần đồng bộ hóa hoặc lần khởi động lại tiếp theo, và các cài đặt [agents] do bạn tự viết sẽ được giữ nguyên.",

  "dash.multiAgentGuidance": "Hướng dẫn Codex cách phân chia công việc",

  "dash.multiAgentGuidanceHint": "Gửi một ghi chú ngắn cho Codex để cho biết cách thức giao việc cho các sub-agents. Đối với v2, nó chỉ định các models có thể sử dụng và model nào nên được ưu tiên; đối với v1, nó chỉ áp dụng ở mức độ lý luận max hoặc ultra. Khi Tắt, sẽ không có ghi chú nào được thêm vào.",

  "dash.injectionNone": "Không có",
  "dash.injectionEffortLabel": "Effort lý luận",

  "dash.injectionEffortNone": "Mặc định của Model",

  "dash.effortCapLabel": "Giới hạn effort V2 ultra",

  "dash.subagentEffortCapLabel": "Giới hạn effort V2 sub-agent",

  "dash.effortCapHelp": "Giới hạn effort suy luận cho các lượt chạy ở chế độ V2 ultra. Khi được thiết lập, các yêu cầu có effort tối đa (từ chế độ ultra) sẽ bị giới hạn ở mức đã chọn. Giới hạn sub-agent chỉ áp dụng cho các agent con được tạo ra. Các giới hạn này chỉ có tác dụng giảm effort, không bao giờ tăng nó. Nếu một model không hỗ trợ mức giới hạn đó, nó sẽ tự động giảm xuống mức được hỗ trợ gần nhất.",

  "dash.effortCapNone": "Không giới hạn",

  "dash.maintenance": "Bảo trì",

  "dash.maintenanceHint": "Làm mới danh sách models của Codex hoặc cài đặt bản phát hành opencodex mới hơn.",

  "dash.syncModels": "Đồng bộ models",

  "dash.syncModelsHint": "Ghi lại catalog model của Codex từ các providers bạn đã kết nối.",

  "dash.syncRun": "Đồng bộ ngay",

  "dash.syncing": "Đang đồng bộ…",

  "dash.syncOk": "Đồng bộ hoàn tất. Đã thêm {count} model(s).",

  "dash.syncStaleHint": "Nếu Codex vẫn hiển thị danh sách cũ, hãy khởi động lại app-server chạy nền của nó ({cmd}).",

  "dash.syncFailed": "Đồng bộ thất bại: {error}",

  "dash.projectConfigTitle": "Cấu hình Codex dự án đang bỏ qua OpenCodex",

  "dash.projectConfigHint": "Các cài đặt nội bộ trong repository này ghi đè proxy OpenCodex (ví dụ: định tuyến trực tiếp đến OpenCode Go). Hãy xóa chúng để định tuyến trong ~/.codex/config.toml được áp dụng cho dự án đó.",

  "dash.checkUpdate": "Kiểm tra bản cập nhật",

  "dash.updateTitle": "Cập nhật opencodex",

  "dash.updateDesc": "Kiểm tra npm cho kênh được chọn, sau đó chọn xem bạn có muốn khởi động lại proxy sau khi cài đặt không.",

  "dash.updateChannel": "Kênh (Channel)",

  "dash.updateChecking": "Đang kiểm tra cập nhật…",

  "dash.updateInstalled": "Đã cài đặt",

  "dash.updateLatest": "Mới nhất",

  "dash.updateAvailable": "Bản cập nhật có sẵn",

  "dash.updateCurrent": "Đã cập nhật mới nhất",

  "dash.updateCommand": "Lệnh",

  "dash.updateSource": "Đây là bản checkout nguồn (source checkout). Hãy cập nhật nó từ terminal bằng lệnh hiển thị.",

  "dash.updateUnavailable": "Không thể đọc phiên bản mới nhất từ npm. Hãy thử lại sau.",

  "dash.updateRetry": "Thử lại",
  "dash.updateRecheck": "Kiểm tra lại",

  "dash.updateCannotAuto": "Tính năng cập nhật bằng một cú nhấp chuột không khả dụng ({reason}).",

  "dash.updateReason.source_checkout": "checkout mã nguồn",

  "dash.updateReason.latest_unavailable": "không thể kết nối với registry npm",

  "dash.updateReason.already_latest": "đã ở phiên bản mới nhất",

  "dash.updateReason.unknown": "cập nhật không khả dụng",

  "dash.updateRestart": "Khởi động lại sau khi cập nhật",

  "dash.updateRestartHint": "Khuyên dùng. GUI hiện tại vẫn tiếp tục chạy mã nguồn cũ cho đến khi proxy khởi động lại.",

  "dash.runUpdate": "Cập nhật",
  "dash.updateReconnecting": "Đang chờ proxy khởi động lại…",

  "dash.updateStatus.running": "Đang cập nhật opencodex.",

  "dash.updateStatus.restarting": "Cập nhật đã được cài đặt. Đang khởi động lại proxy.",

  "dash.updateStatus.succeeded": "Quá trình cập nhật hoàn tất.",

  "dash.updateVersionTransition": "{currentVersion} -> {latestVersion}.",


  "dash.updateStatus.failed": "Cập nhật thất bại.",


  // providers
  "prov.subtitle": "Cấu hình các upstream providers mà opencodex sẽ định tuyến vào Codex. Đăng nhập bằng một tài khoản, thêm một provider, hoặc chỉnh sửa file config trực tiếp.",

  "prov.add": "Thêm Provider",
  "prov.editJson": "Chỉnh sửa JSON",

  "prov.accountLogin": "Đăng nhập tài khoản",

  "prov.noOauth": "Không có các OAuth providers khả dụng.",

  "prov.loggedIn": "đã đăng nhập",

  "prov.notLoggedIn": "chưa đăng nhập",

  "prov.logout": "Đăng xuất",

  "prov.login": "Đăng nhập",

  "prov.loginWith": "Đăng nhập với {provider}",

  "prov.waitingBrowser": "Đang đợi trình duyệt…",

  "prov.didntOpen": "Không mở được? Nhấp vào đây",

  "prov.copyLink": "Sao chép liên kết",

  "prov.dontOpenBrowser": "Không mở trình duyệt trên máy chạy proxy",

  "prov.dontOpenBrowserHint": "Hữu ích đối với profile trình duyệt khác, hoặc khi bảng điều khiển (dashboard) không nằm trên máy cài proxy.",

  "prov.linkCopied": "Đã sao chép",
  "prov.linkCopyUnavailable": "Clipboard không khả dụng",

  "prov.deviceCode": "Mã thiết bị",

  "prov.copyCode": "Sao chép mã",

  "prov.codeCopied": "Đã sao chép mã",

  "prov.editAlias": "Chỉnh sửa bí danh",

  "prov.aliasPrompt": "Tên hiển thị (để trống để xoá)",

  "prov.aliasSaved": "Đã lưu bí danh",

  "prov.aliasSaveFailed": "Không thể lưu bí danh",

  "prov.accountId": "ID",

  "prov.pasteRedirect": "Dán URL chuyển hướng hoặc mã",

  "prov.pasteRedirectHint": "Nếu trình duyệt hiển thị lỗi localhost, hãy sao chép URL đầy đủ từ thanh địa chỉ và dán nó vào đây (hoặc dán authorization code).",

  "prov.pasteSubmit": "Gửi",

  "prov.pasteSubmitting": "Đang gửi…",

  "prov.pasteOk": "Mã đã được gửi — đang hoàn tất đăng nhập…",

  "prov.pasteFail": "Không thể gửi mã: {error}",

  "prov.port": "Cổng (Port)",

  "prov.default": "Mặc định",
  "prov.loadingConfig": "Đang tải…",
  "prov.saved": "Đã lưu! Hãy khởi động lại proxy để áp dụng.",

  "prov.loadConfigFail": "Không thể tải cấu hình",

  "prov.invalidJson": "JSON không hợp lệ",

  "prov.saveFailed": "Lưu thất bại",

  "prov.loginFailStart": "Quá trình đăng nhập {provider} không thể bắt đầu",

  "prov.loginError": "Lỗi đăng nhập {provider}: {error}",

  "prov.loginRequestFail": "Yêu cầu đăng nhập {provider} thất bại",

  "prov.loginCancelled": "Đã huỷ đăng nhập {provider}",

  "prov.loginTimeout": "Đăng nhập {provider} bị quá thời gian (timed out) — trình duyệt đã đóng hoặc quá trình đăng nhập không hoàn tất. Hãy thử lại.",

  "prov.loginOk": "Đã đăng nhập vào {provider}. Hãy chạy {cmd} (hoặc tự động áp dụng) để liệt kê các models của nó.",

  "prov.loginSameAccount": "Vẫn là tài khoản {provider} đó — hãy chuyển đổi các tài khoản trong trình duyệt, sau đó thử Thêm tài khoản lại.",

  "oauthTos.highTitle": "{provider}: rủi ro đăng ký (subscription) OAuth",

  "oauthTos.elevatedTitle": "{provider}: cầu nối OAuth không chính thức",

  "oauthTos.anthropicBody": "Việc sử dụng lại trực tiếp token OAuth subscription của Claude thông qua proxy của bên thứ ba như OpenCodex không phải là phương thức tích hợp được Anthropic hỗ trợ và có thể dẫn đến việc hạn chế truy cập. Các tích hợp Agent SDK được hỗ trợ có dùng các Claude subscriptions là một phần riêng biệt.",

  "oauthTos.highBody": "OpenCodex kết nối với {provider} thông qua một đường dẫn OAuth của bên thứ ba. Việc sử dụng không được hỗ trợ có thể dẫn đến giới hạn hoặc bị đình chỉ truy cập.",

  "oauthTos.elevatedBody": "OpenCodex kết nối {provider} qua đường dẫn OAuth không chính thức. Hãy sử dụng client chính thức khi có thể; lưu lượng truy cập tự động hoặc bất thường có thể bị coi là lạm dụng và có thể bị giới hạn hoặc đình chỉ truy cập.",

  "oauthTos.saferPath": "Giải pháp an toàn hơn: cấu hình một API key trong OpenCodex thay thế.",

  "oauthTos.acknowledge": "Tôi hiểu rõ rủi ro và vẫn muốn tiếp tục với OAuth.",

  "oauthTos.continue": "Tiếp tục với OAuth",

  "prov.logoutOk": "Đã đăng xuất khỏi {provider}.",

  "prov.logoutFail": "Không thể đăng xuất khỏi {provider}. Trạng thái tài khoản của bạn vẫn không thay đổi.",

  "prov.removed": "Đã xóa \"{name}\".",

  "prov.removedDefault": "Đã xoá \"{name}\". Provider mặc định hiện tại là \"{defaultProvider}\".",

  "prov.removeFail": "Xóa \"{name}\" thất bại.",

  "prov.removeLastProvider": "Bạn không thể xóa provider này khi không có provider nào khác đang bật để có thể trở thành mặc định.",

  "prov.removeHasDependentCombos": "Hãy xóa hoặc cập nhật các combo phụ thuộc này trước: {combos}.",

  "prov.setDefault": "Đặt làm mặc định",

  "prov.setDefaultSuccess": "\"{name}\" hiện là provider mặc định.",

  "prov.setDefaultFail": "Không thể đặt \"{name}\" làm provider mặc định.",

  "prov.defaultDisabled": "Hãy bật provider này trước khi đặt nó làm mặc định.",

  "prov.updateFail": "Không thể cập nhật provider này.",

  "prov.networkError": "Lỗi mạng. Kiểm tra xem proxy có đang chạy không và thử lại.",

  "prov.added": "Đã thêm \"{name}\". Đang trực tiếp ngay bây giờ — hãy chạy {cmd} (hoặc khởi động lại) để hiển thị các models của nó trong bộ chọn của Codex.",

  "prov.modelsNoticeTitle": "Chọn models",

  "prov.modelsNoticeChecking": "Đang kiểm tra danh sách model. Việc chuyển đổi models không vô hiệu hoá provider.",

  "prov.modelsNoticePending": "Danh sách model ban đầu chưa được xác nhận. Các models sẽ bị ẩn cho đến khi quá trình khám phá kết thúc.",

  "prov.modelsNoticeOff": "Tất cả các chuyển đổi model đều bị TẮT lúc đăng ký. Bật các models mà bạn muốn ở trang Models.",

  "prov.modelsNoticeReady": "Chọn những models sẽ xuất hiện trên trang Models. Việc chuyển đổi models không vô hiệu hoá provider.",

  "prov.modelsNoticeFailed": "Provider đã được lưu, nhưng không thể làm mới danh sách model. Vui lòng thử lại.",

  "prov.modelsNoticeCount": "{count} models",

  "prov.modelsNoticeOpen": "Mở Models",

  "models.initialSelectionPending": "Đang chờ khám phá ban đầu",

  "prov.removeConfirm": "Xóa provider \"{name}\"? Models của provider này sẽ biến mất khỏi bộ chọn của Codex.",

  "prov.hasApiKey": "đã định cấu hình api key",

  "prov.hasHeaders": "đã định cấu hình tiêu đề tùy chỉnh (custom headers)",

  "prov.accounts": "Tài khoản ({n})",

  "prov.accountsAria": "Bật tắt các tài khoản {name}",

  "prov.accountActive": "Đang hoạt động",
  "prov.accountReauth": "Đăng nhập lại",

  "prov.reauthenticate": "Xác thực lại",

  "prov.reauthAccountMissing": "Tài khoản đã chọn không được tìm thấy sau khi đăng nhập",

  "prov.reauthIdentityMismatch": "Tài khoản đã đăng nhập không khớp với tài khoản đã chọn",

  "prov.accountAdd": "Thêm tài khoản",

  "prov.accountNoLabel": "tài khoản {id}",

  "prov.accountSwitchTitle": "Sử dụng tài khoản này",

  "prov.accountSwitched": "Đã chuyển sang {email}.",

  "prov.accountSwitchFail": "Chuyển tài khoản thất bại",

  "prov.accountRemoved": "Đã xóa {email}.",

  "prov.accountRemoveFail": "Không thể xóa {email}. Tài khoản không bị thay đổi.",

  "prov.accountRemoveAria": "Xóa {email}",

  "prov.accountRemoveConfirm": "Xóa tài khoản {email}? Thông tin đăng nhập của nó sẽ bị xóa khỏi proxy này.",

  "prov.keyAdd": "Thêm API key",

  "prov.keyAdded": "Đã thêm API key vào {name}.",

  "prov.keyAddFail": "Thêm API key thất bại",

  "prov.keyPlaceholder": "Dán API key",

  "prov.keySwitchTitle": "Sử dụng key này",

  "prov.keySwitched": "Đã chuyển sang key {key}.",

  "prov.keySwitchFail": "Chuyển key thất bại",

  "prov.keyRemoved": "Đã xóa key {key}.",

  "prov.keyRemoveAria": "Xóa key {key}",

  "prov.keyRemoveConfirm": "Xóa API key {key}? API key sẽ bị xóa khỏi cấu hình của proxy này.",

  "prov.activeBadge": "Đang hoạt động",
  "prov.disabledBadge": "Đã tắt",
  "prov.defaultBadge": "Mặc định",
  "prov.enable": "Bật",

  "prov.disable": "Tắt",

  "prov.enabled": "Đã Bật \"{name}\". Models của provider này có thể xuất hiện lại trong Codex.",

  "prov.disabled": "Đã Tắt \"{name}\". Các cài đặt vẫn được giữ lại nhưng models của nó sẽ bị ẩn.",

  "prov.enableFail": "Bật \"{name}\" thất bại.",

  "prov.disableFail": "Tắt \"{name}\" thất bại.",

  "prov.enableAria": "Bật provider {name}",

  "prov.disableAria": "Tắt provider {name}",

  "prov.defaultCannotDisable": "Không thể tắt provider mặc định",

  "prov.openaiAccountMode": "Chế độ tài khoản Codex",

  "prov.openaiModePool": "Nhóm (Pool)",

  "prov.openaiModeDirect": "Trực tiếp",

  "prov.openaiPoolDesc": "Mặc định. Xoay vòng tài khoản đăng nhập chính và các tài khoản đã thêm dựa trên mức độ yêu thích (affinity), hạn ngạch, thời gian chờ (cooldown) và khả năng chuyển đổi dự phòng (failover).",

  "prov.openaiDirectDesc": "Chỉ sử dụng tài khoản đăng nhập Codex hiện tại/chính. Các tài khoản nhóm đã lưu không được đọc hoặc luân phiên.",

  "prov.openaiModeSaved": "Chế độ tài khoản OpenAI đã chuyển thành {mode}.",

  "prov.openaiModeSaveFailed": "Không thể thay đổi chế độ tài khoản OpenAI.",

  "prov.openaiApiDesc": "Sử dụng API key OpenAI và không bao giờ sử dụng chứng chỉ thông tin tài khoản Codex.",

  "prov.manageCodexAccounts": "Quản lý các tài khoản Codex",

  "prov.openaiApiMissing": "Yêu cầu có API key",

  "prov.openaiApiSetup": "Thiết lập API key",


  // models
  "models.tab.catalog": "Models",

  "models.tab.combos": "Combos",

  "models.tab.compatibility": "Tương thích",

  "models.tab.routing": "Định tuyến (beta)",

  "models.tabsLabel": "Các bề mặt Model",

  "models.subtitle.combos": "Các nhóm models được sắp xếp theo thứ tự để trả lời dưới dạng một id duy nhất. Xâu chuỗi các mục tiêu cùng khả năng chuyển đổi dự phòng (failover) hoặc chia đều mức tải với một chiến lược cân bằng (balancing strategy).",

  "models.subtitle.compatibility": "Ma trận phán quyết khả năng tương thích ở chế độ chỉ đọc dựa trên bằng chứng thu thập (projection evidence) từ lab.",

  "models.subtitle.routing": "Hồ sơ chính sách, đánh giá chạy thử (dry-run) và phân tích định tuyến dựa trên nguồn.",

  "models.subtitle": "Bật hoặc tắt các models mà Codex nhìn thấy — bao gồm truyền thẳng (passthrough) GPT native và các providers được định tuyến, nhóm theo provider (bấm vào một tiêu đề để thu gọn). Models bị ẩn sẽ không hiển thị trên catalog và bộ chọn model nhưng vẫn có thể gọi trực tiếp thông qua id chính xác của chúng. Thay đổi sẽ áp dụng ở lượt chạy tiếp theo của Codex — opencodex sẽ vô hiệu hoá bộ nhớ đệm model 5 phút của Codex nên không cần khởi động lại.",

  "models.nativeGroupLabel": "OpenAI native",

  "models.nativeHint": "Các models truyền thẳng (passthrough) sử dụng tùy chọn tài khoản Nhóm (Pool) hoặc Trực tiếp (Direct) được chọn trên màn hình Providers. Khi Tắt một tính năng, nó sẽ bị ẩn khỏi bộ chọn Codex (mục nhập catalog vẫn được giữ lại, vì vậy khi Bật lại thì mọi thứ vẫn được khôi phục chính xác). Thêm một model tại đây sẽ đăng ký định tuyến selector `openai/<model>`, chứ không phải là một id truyền thẳng mới.",

  "models.active": "{active}/{total} đang hiển thị",

  "models.workspace.providers": "Nhà cung cấp",
  "models.workspace.allProviders": "Tất cả các providers",

  "models.workspace.mainAria": "Chi tiết Model",

  "models.allOn": "Bật tất cả",

  "models.allOff": "Tắt tất cả",

  "models.presetLabel": "Models",

  "models.presetMode_preset": "Mặc định (Preset)",

  "models.presetMode_all": "Tất cả",
  "models.presetMode_custom": "Tùy chỉnh",
  "models.presetSummary": "{count} trong số {total} đang được hiển thị — cấu hình chuẩn v{version}",

  "models.presetUpdateAvailable": "Preset v{version} hiện có sẵn",

  "models.presetAppliedToast": "{provider}: đã áp dụng preset — có {count} models được chọn",

  "models.presetClearedToast": "{provider}: đang hiển thị tất cả các models",

  "models.presetEmpty": "{provider}: preset không khớp với bất kỳ models nào — lựa chọn không thay đổi",

  "models.presetConfirmReplace": "Thay thế các lựa chọn của bạn bằng preset {count}-model?",

  "models.cap350k": "Giới hạn 350k",

  "models.capApplied": "Giới hạn ngữ cảnh (Context cap) đã được áp dụng — sẽ có hiệu lực ở lượt chạy Codex tiếp theo.",

  "models.capSaveFailed": "Không thể lưu giới hạn ngữ cảnh",

  "models.contextCapped": "Giới hạn 350k",

  "models.contextCapLabel": "Cửa sổ/Giới hạn (Window / cap) mặc định",

  "models.v2Label": "Sub-agent",

  "models.shadowCallOriginal": "⚠ {models} →",

  "models.v2DocsLink": "v1 / v2 là gì?",

  "models.v2Mode_v1": "v1",

  "models.v2Mode_default": "mặc định",

  "models.v2Mode_v2": "v2",

  "models.v2ModeDesc_v1": "Tất cả model → giao diện v1",

  "models.v2ModeDesc_default": "Mặc định của upstream (sol/terra=v2, luna=v1)",

  "models.v2ModeDesc_v2": "Tất cả model → giao diện v2",

  "models.keepNativeOnV1": "Giữ ChatGPT ở v1",

  "models.keepNativeOnV1Hint": "ChatGPT chỉ mã hoá các task con v2 khi model cha ChatGPT-native giữ ở v2, khiến Grok và Claude không thể đọc được chúng. Bật tuỳ chọn này để giữ Sol/Terra ở v1 và tránh việc mã hoá đó. Các model cha được định tuyến (routed parents) vẫn ở v2.",

  "models.v2Help": "Điều khiển giao diện đa agent (multi-agent surface) cho tất cả model.\n\nv1: Agent luồng đơn cổ điển. Mọi model đều sử dụng giao diện cộng tác v1.\nbase: Mặc định của upstream — sol/terra dùng v2, luna dùng v1, các model khác tuân theo cờ tính năng (feature flag) của codex.\nv2: Agent đa luồng với spawn_agent. Mọi model đều sử dụng giao diện cộng tác v2.\n\nỞ v2, tuỳ chọn Giữ ChatGPT ở v1 sẽ giữ Sol/Terra ở giao diện v1 để chúng vẫn có thể gọi Grok hoặc Claude. ChatGPT mã hoá các task con v2; các model được định tuyến không thể đọc được chúng. Các model cha được định tuyến vẫn giữ ở v2.\n\nCác thay đổi sẽ áp dụng cho các phiên (sessions) mới.",

  "dash.multiAgent": "Agent con (Sub-agent)",

  "dash.codexDesktopAuthless": "Mở Codex không cần đăng nhập",

  "dash.codexDesktopAuthlessHint": "Mặc định tắt. Bỏ qua bước đăng nhập Desktop riêng cho các kết nối cục bộ hợp lệ. Vẫn cần thông tin xác thực upstream. Khởi động lại Codex sau khi thay đổi cài đặt này. Các tính năng Desktop yêu cầu tài khoản có thể không khả dụng.",

  "dash.codexClientCompaction": "Sử dụng tính năng thu gọn phía client (client-side compaction)",

  "dash.codexClientCompactionHint": "Mặc định tắt; chỉ dành cho authenticated loopback. Các compactions trong tương lai sẽ lưu trữ các bản tóm tắt văn bản thuần trong khi OpenCodeX và V2 provider routing vẫn hoạt động; provider được cấu hình có thể xử lý chúng và tiêu tốn quota. Lịch sử được giữ nguyên, và các luồng (threads) hiện tại tiếp tục định tuyến qua proxy thông qua ghi đè openai_base_url mà OpenCodeX quản lý; nếu bạn tự thiết lập dòng đó, nó sẽ được giữ lại và các luồng đó sẽ tuân theo đích đến của bạn thay thế. Lịch sử ocx1 hiện tại vẫn có thể khôi phục được; chỉ khôi phục một luồng riêng biệt trước khi phát lại (replay) trong Codex native. Khởi động lại Codex sau khi thay đổi cài đặt này.",

  "models.v2Conflict": "[agents] max_threads đã được thiết lập — codex sẽ từ chối khởi động; hãy xoá nó khỏi config.toml",

  "models.v2Applied": "Chế độ agent con đã được cập nhật — áp dụng cho các phiên mới (khởi động lại ứng dụng Codex để làm mới picker)",

  "models.v2ThreadsLabel": "Luồng tối đa (Max threads)",

  "models.v2ThreadsDefault": "mặc định (4)",

  "models.v2ThreadsApplied": "Giới hạn luồng đã được cập nhật — áp dụng cho các phiên mới",

  "models.v2ThreadsInvalid": "Giới hạn luồng phải là số nguyên >= 1",

  "models.v2ThreadsApply": "Áp dụng",
  "models.capValue": "Mặc định {value}",

  "models.contextSettings": "Cửa sổ tuỳ chỉnh (Custom windows)",

  "models.contextSettingsTitle": "Cửa sổ tuỳ chỉnh — {provider}",

  "models.contextDefault": "Mặc định của provider",

  "models.contextModel": "Model",

  "models.contextModelOverride": "Ghi đè model",

  "models.contextHint": "Ghi cửa sổ (window) Codex thực tế vào đây khi bạn đã biết nó. Việc này điền vào một cửa sổ upstream bị thiếu và chỉ làm giảm bớt nếu cửa sổ được báo cáo lớn hơn. Để trống để sử dụng cửa sổ/giới hạn Mặc định của provider, hoặc 128k nếu giới hạn đó đã bị tắt.",

  "models.contextAutomatic": "Khám phá tự động (Automatic discovery)",

  "models.contextSaved": "Cửa sổ ngữ cảnh (Context windows) đã được cập nhật — có hiệu lực ở lượt Codex tiếp theo.",

  "models.contextUnchanged": "Không có thay đổi nào về cửa sổ ngữ cảnh để lưu.",

  "models.contextSaveFailed": "Lỗi lưu cửa sổ ngữ cảnh",

  "models.contextInvalid": "Cửa sổ ngữ cảnh phải là số nguyên dương",

  "models.contextCappedValue": "giới hạn {value}",

  "models.setAll": "Thiết lập tất cả",

  "models.setAllHint": "Bật cửa sổ mặc định {value} cho mọi provider được định tuyến. Các relay bỏ qua context_window / context_length sẽ nhận giá trị này làm cửa sổ Codex thực tế. Sử dụng Cửa sổ tuỳ chỉnh trên một hàng provider để thiết lập một model bằng tay. Các native provider không bị ảnh hưởng.",

  "models.collapseAll": "Thu gọn tất cả",

  "models.expandAll": "Mở rộng tất cả",

  "models.orderHint": "Thứ tự mặc định tuân theo các lựa chọn nổi bật (featured) và ưu tiên của catalog (catalog priority), với cách sắp xếp provider/model cho các hàng được định tuyến ngang nhau. Thứ tự picker được lưu có thể ghi đè thứ tự hiển thị; các công tắc hiển thị (visibility switches) lọc ra những hàng nào sẽ xuất hiện. Các client có thể giữ danh mục cũ cho đến khi được mở lại.",

  "models.custom": "Tuỳ chỉnh…",

  "models.customApply": "Áp dụng",
  "models.customPlaceholder": "Tokens (ví dụ: 420000)",

  "models.customAdd": "Thêm model tuỳ chỉnh",

  "models.customAddTitle": "Thêm model tuỳ chỉnh — {provider}",

  "models.customEditTitle": "Chỉnh sửa model tuỳ chỉnh — {provider}",

  "pws.manageModelVisibility": "Quản lý hiển thị trong Models",

  "pws.modelOwnershipLoading": "Đang kiểm tra định nghĩa model…",

  "pws.modelOwnershipFailed": "Không thể tải định nghĩa model. Hãy thử lại trước khi thay đổi.",

  "pws.modelSelectionPending": "Hoàn tất việc chọn model trong Models trước khi thay đổi.",

  "pws.modelSaved": "Định nghĩa model tuỳ chỉnh đã được lưu.",

  "pws.modelSavedHidden": "Đã lưu định nghĩa. Model này đang bị ẩn; hãy quản lý hiển thị trong Models.",

  "pws.modelSavedRefreshPending": "Đã lưu định nghĩa, nhưng không thể làm mới danh mục model (model catalog). Hãy thử làm mới lại; đừng thêm lại model đó.",

  "pws.modelMutationUnconfirmed": "Không thể xác nhận thay đổi. Hãy làm mới danh sách model trước khi thử lại.",

  "pws.modelRemovedRefreshPending": "Thay đổi đã được lưu, nhưng không thể làm mới danh mục model. Hãy thử làm mới lại.",

  "pws.modelHidden": "Model đã ẩn. Khôi phục hiển thị trong Models.",

  "pws.modelDefinitionDeleted": "Định nghĩa tuỳ chỉnh đã bị xoá. Một model cơ sở (underlying model) vẫn có thể xuất hiện.",

  "pws.modelKnown": "Model này đã được nhận diện. Quản lý hiển thị của nó trong Models.",

  "models.customAdded": "Đã thêm model tuỳ chỉnh",

  "models.customUpdated": "Đã cập nhật model tuỳ chỉnh",

  "models.customDeleted": "Đã xoá model tuỳ chỉnh",

  "models.customSaveFailed": "Lỗi lưu model tuỳ chỉnh",

  "models.customSaving": "Đang lưu…",

  "models.customAddBtn": "Thêm",
  "models.customEditBtn": "Cập nhật",
  "models.customEdit": "Chỉnh sửa",
  "models.customDelete": "Xóa",
  "models.customDeleteConfirm": "Xoá định nghĩa tuỳ chỉnh cho {name}? Một model gốc hoặc được khám phá tự động có thể xuất hiện trở lại.",

  "models.hide": "Ẩn",

  "models.hideConfirm": "Ẩn {name} khỏi danh mục model? Điều này không xoá định nghĩa của nó hay thay đổi chính sách định tuyến trực tiếp.",

  "models.customBadge": "Tùy chỉnh",
  "models.customSummary": "{count} tuỳ chỉnh",

  "models.customFieldModelId": "Model ID (endpoint slug)",

  "models.customFieldModelIdPlaceholder": "ví dụ: qwen4-max-preview",

  "models.customFieldDisplayName": "Tên hiển thị (không bắt buộc)",

  "models.customFieldDisplayNamePlaceholder": "ví dụ: Qwen 4 Max Preview",

  "models.customFieldContext": "Cửa sổ ngữ cảnh (Context window)",

  "models.customFieldModalities": "Đầu vào (Input modalities)",

  "models.customFieldReasoning": "Nỗ lực suy luận (Reasoning effort)",

  "models.customFieldReasoningOverride": "Ghi đè nỗ lực suy luận (Override reasoning effort)",

  "models.reasoningEffort.none": "Không có",
  "models.reasoningEffort.minimal": "Tối thiểu (Minimal)",

  "models.reasoningEffort.low": "Thấp (Low)",

  "models.reasoningEffort.medium": "Trung bình (Medium)",

  "models.reasoningEffort.high": "Cao (High)",

  "models.reasoningEffort.xhigh": "Rất cao (Extra high)",

  "models.reasoningEffort.max": "Tối đa (Maximum)",

  "models.tipProvider": "Nhà cung cấp",

  "models.tipContext": "Ngữ cảnh",

  "models.tipModalities": "Đầu vào (Modalities)",

  "models.tipStatus": "Trạng thái",
  "models.tipActive": "Đang hoạt động",
  "models.tipDisabled": "Đã tắt",
  "models.applied": "Đã áp dụng — có hiệu lực ở lượt Codex tiếp theo.",

  "models.integrationRefreshWarning": "Đã lưu lựa chọn model. Một số danh mục client không thể được làm mới. Hãy kiểm tra Integrations trước khi bắt đầu phiên mới.",

  "models.saveFailed": "Lưu thất bại",

  "models.networkError": "Lỗi mạng — proxy có đang chạy không?",

  "models.loadFail": "Lỗi tải danh sách model — proxy có đang chạy không?",

  "models.noRouted": "Không có model được định tuyến",

  "models.noRoutedHint": "Vui lòng đăng nhập vào một provider hoặc thêm một model trước.",

  "models.emptyDiscovery": "Không tìm thấy model nào. Hãy kiểm tra endpoint của provider hoặc thêm model tĩnh/tuỳ chỉnh.",

  "models.emptyDiscoveryDisabled": "Tính năng khám phá model trực tiếp đang tắt và không có model tĩnh nào được cấu hình.",

  "models.discoveryFailedBadge": "Khám phá thất bại",

  "models.discoveryFailedHttp": "Khám phá model thất bại (HTTP {status}).",

  "models.discoveryFailedBlocked": "Khám phá model bị chặn bởi chính sách đích.",

  "models.discoveryFailedInvalidResponse": "Khám phá model trả về phản hồi không hợp lệ.",

  "models.discoveryFailedNetwork": "Khám phá model thất bại do lỗi mạng.",

  "models.discoveryFailedProvider": "Provider báo lỗi khám phá model.",

  "models.discoveryFailedGeneric": "Khám phá model thất bại.",

  "models.openProviderSettings": "Mở cài đặt provider",

  "models.inactiveNoCredit": "Hết credit",

  "models.inactiveNoCreditHint": "Mọi provider phía sau mục này hiện đều đã hết credit, do đó yêu cầu sẽ thất bại. Nó vẫn hiển thị trong danh sách và có thể sử dụng lại khi credit được đặt lại hoặc nạp thêm.",

  "models.discoveryFailedDependency": "Tính năng khám phá model đang bật cho provider này. Trong khi tính năng này liên tục thất bại, hãy tắt “{control}” trong cài đặt provider để sử dụng các model được thêm thủ công hoặc model tĩnh để thay thế.",

  "models.loading": "Đang tải…",
  "models.search": "Tìm kiếm model…",

  "models.showMore": "Hiển thị thêm {n}",

  "models.freeOnly": "Chỉ miễn phí",

  "models.noFreeMatch": "Không có model miễn phí ở đây. Tắt Chỉ miễn phí để xem phần còn lại.",

  "models.allowlistLabel": "Chỉ các mục đã chọn",

  "models.allowlistHint": "Chỉ các model được chọn mới gửi đến danh mục (để trống = tất cả). Hữu ích cho các provider cung cấp hàng nghìn model.",

  "models.selectedCount": "Đã chọn {n}",


  // subagents
  "sub.subtitle": "{cmd} của Codex chỉ quảng bá 5 model đầu tiên (theo mức độ ưu tiên) làm ghi đè (overrides). Chọn tối đa 5 model ở đây — native gpt hoặc routed — và opencodex sẽ đặt mức độ ưu tiên trong catalog của chúng để những model này dẫn đầu. Bất kỳ model nào khác vẫn có thể được gọi bằng đúng tên của nó; cài đặt này chỉ kiểm soát những gì được hiển thị.",

  "sub.featured": "Nổi bật (Featured)",

  "sub.advanced": "Nâng cao (Advanced)",

  "sub.orderHintAria": "Cách thứ tự này được sử dụng",

  "sub.orderHint": "Thứ tự hiển thị ở đây thiết lập các vị trí 1–5 ở đầu picker model của Codex và các model mặc định cho {cmd}.",

  "sub.noneSelected": "Chưa chọn — hãy chọn từ danh sách bên dưới.",

  "sub.models": "Models",

  "sub.search": "Tìm kiếm model (native gpt + routed)…",

  "sub.settings": "Cài đặt",
  "sub.sections": "Các phần agent con (Subagent sections)",

  "sub.delegation.model": "Model sẽ gọi đầu tiên",

  "sub.delegation.modelHint": "Model mà Codex gọi đầu tiên khi bàn giao (hands off) công việc. Nổi bật bên trên là danh sách model nó có thể gọi; đây là model nó gọi đầu tiên.",

  "sub.noModels": "Không có model — vui lòng đăng nhập vào provider hoặc thêm model trước.",

  "sub.saved": "Đã lưu {n} model. Hãy bắt đầu phiên Codex mới (hoặc chạy {cmd}) để thấy chúng dưới dạng ghi đè spawn_agent.",

  "sub.saveFailed": "Lưu thất bại",

  "sub.networkError": "Lỗi mạng — proxy có đang chạy không?",

  "sub.loadFail": "Lỗi tải model — proxy có đang chạy không?",

  "sub.loading": "Đang tải…",
  "sub.moveUp": "Di chuyển {m} lên",

  "sub.moveDown": "Di chuyển {m} xuống",

  "sub.removeAria": "Xoá {m}",

  "sub.workspace.addToFeatured": "Thêm {m} vào phần Nổi bật",

  "sub.workspace.allModels": "Tất cả model",

  "sub.workspace.featuredFull": "Danh sách Nổi bật đã đầy (tối đa 5)",

  "sub.workspace.mainAria": "Chi tiết model của agent con",

  "sub.workspace.notFeatured": "Không nổi bật",

  "sub.workspace.priority": "Ưu tiên",

  "sub.ultraMode": "Luôn uỷ quyền chủ động",

  "sub.ultraModeHint": "Bật chính sách uỷ quyền đa agent chủ động (Proactive multi-agent delegation) cho mọi model và nỗ lực suy luận (không làm thay đổi bản thân nỗ lực suy luận). Ghi thiết lập vào features.multi_agent_v2.multi_agent_mode_hint_text trong config.toml.",

  "sub.ultraModeV2Required": "Yêu cầu giao diện đa agent v2 (v2 multi-agent surface) — bật multi_agent_v2 và chọn v2 trong trình điều khiển Chế độ agent con (Sub-agent mode) trước.",

  "sub.ultraModeText": "Văn bản uỷ quyền chủ động",

  "sub.ultraModePreset": "Khôi phục preset",

  "sub.ultraModeLoadFail": "Lỗi tải cài đặt uỷ quyền chủ động — proxy có đang chạy không?",

  "sub.ultraModeSaveFail": "Lỗi lưu cài đặt uỷ quyền chủ động",

  "sub.ultraModeSaved": "Đã lưu uỷ quyền chủ động. Áp dụng cho các phiên Codex mới.",

  "sub.workspace.removeFromFeatured": "Xoá {m} khỏi phần Nổi bật",

  "sub.workspace.selectModel": "Chọn một model",

  "sub.workspace.selectModelDesc": "Chọn một model từ danh sách để xem chi tiết và đưa nó vào danh sách nổi bật cho spawn_agent.",

  "sub.workspace.selector": "Bộ chọn công khai (Public selector)",

  "sub.fallbackLabel": "Chuỗi dự phòng của agent con",

  "sub.fallbackHint": "Các model có thứ tự được thử nghiệm khi model agent con không khả dụng hoặc bị lỗi.",

  "sub.fallbackAdd": "Thêm model dự phòng…",

  "sub.fallbackPoll": "Khoảng thời gian kiểm tra khả dụng (Availability check interval)",

  "sub.fallbackSaved": "Đã lưu cài đặt dự phòng của agent con.",

  "sub.fallbackSaveFailed": "Lỗi lưu cài đặt dự phòng",

  "sub.fallbackUnavailable": "Hiện không được quảng bá; vẫn được giữ trong chuỗi dự phòng.",

  "sub.fallbackPollInvalid": "Vui lòng nhập một số nguyên từ 5000 đến 600000 ms.",

  "sub.v2Compatibility.title": "Khả năng tương thích V2 của Native-parent",

  "sub.v2Compatibility.risk": "Nếu model cha ChatGPT-native uỷ quyền cho model định tuyến (routed model) này bằng V2, task của nó có thể bị mã hoá và thất bại trước khi thực thi. Các task có thể đọc được từ model cha định tuyến không bị ảnh hưởng.",

  "sub.v2Compatibility.recoveryUnknown": "Trạng thái bật phục hồi/đủ điều kiện không được tiết lộ bởi máy chủ này. Hãy dùng V1/uỷ quyền tương thích văn bản thuần (plaintext-compatible delegation), hoặc chỉ bật khôi phục V2 thử nghiệm (experimental V2 recovery) nếu đủ điều kiện. Khôi phục sẽ tăng thêm tiêu tốn quota, độ trễ, phụ thuộc backend và có khả năng làm giảm độ chính xác; nó không sửa được giao thức upstream.",

  "sub.v2Compatibility.details": "Chi tiết tương thích",


  // logs
  "logs.title": "Nhật ký yêu cầu",

  "logs.tabLogs": "Nhật ký",

  "logs.tabDebug": "Gỡ lỗi",

  "logs.subtitle": "Các request gần đây được định tuyến qua local opencodex proxy, mới nhất ở trên cùng.",

  "logs.autoRefresh": "Tự động làm mới",

  "logs.noRequests": "Chưa có request nào.",

  "logs.loadError": "Không thể tải logs request.",

  "logs.filter.surface.label": "Giao diện (Surface)",

  "logs.filter.model.all": "Tất cả model",

  "logs.filter.provider.label": "Nhà cung cấp",

  "logs.filter.provider.all": "Tất cả provider",

  "logs.filter.status.label": "Trạng thái",
  "logs.filter.status.all": "Tất cả trạng thái",

  "logs.filter.status.success": "Thành công (2xx)",

  "logs.filter.status.errors": "Lỗi (4xx/5xx)",

  "logs.filter.time.label": "Thời gian",

  "logs.filter.time.all": "Tất cả thời gian",

  "logs.filter.time.15m": "15 phút qua",

  "logs.filter.time.1h": "1 giờ qua",

  "logs.filter.time.24h": "1 ngày qua",

  "logs.filter.speed.label": "Tốc độ",

  "logs.filter.speed.all": "Tất cả tốc độ",

  "logs.filter.speed.slow": "< 15 tok/s",

  "logs.filter.speed.medium": "15–< 50 tok/s",

  "logs.filter.speed.fast": "≥ 50 tok/s",

  "logs.filter.reset": "Đặt lại bộ lọc",

  "logs.filter.showingCount": "Đang hiển thị {count} / {total}",

  "logs.noMatchingRequests": "Không có request nào phù hợp.",

  "logs.filter.surface.all": "Tất cả",
  "logs.filter.surface.claude": "Claude",

  "logs.filter.surface.codex": "Codex",

  "logs.filter.surface.grok": "Grok",

  "logs.filter.interceptedHelpersOnly": "Chỉ helper bị chặn lại (Intercepted helpers only)",

  "logs.badge.interceptedHelper": "I · {model}",

  "logs.badge.interceptedHelperTitle": "Yêu cầu phụ trợ bị chặn",

  "logs.filter.conversation.label": "Cuộc hội thoại",

  "logs.filter.conversation.placeholder": "Dán id cuộc hội thoại",

 "logs.filter.conversation.clear": "Xoá",

  "logs.filter.model.label": "Model",

  "logs.filter.model.placeholder": "Lọc theo model hoặc provider",

  "logs.filter.conversation.apply": "Lọc logs",

  "logs.conversation.totals": "{requests} yêu cầu · {tokens} token · {cost}",

  "logs.conversation.scope": "Tổng số liệu chỉ áp dụng cho bộ đệm Logs đang được tải.",

  "logs.conversation.excluded": "(đã loại trừ {unpriced} không có giá, {unmetered} không đo lường khỏi khoản ước tính ~$)",

  "logs.cost.approximate": "{amount}",

  "logs.cost.lowerBound": "≥{amount}",

  "logs.cost.unavailable": "—",
  "logs.detail.conversation": "Cuộc hội thoại",

  "logs.badge.claude": "Claude",

  "logs.badge.grok": "Grok",

  "logs.col.time": "Thời gian",

  "logs.col.request": "Yêu cầu",

  "logs.col.model": "Model",

  "logs.col.effort": "Nỗ lực (Effort)",

  "logs.col.provider": "Nhà cung cấp",

  "logs.col.status": "Trạng thái",
  "logs.col.tokens": "Tokens",

  "logs.col.tokPerSec": "tok/s",

  "logs.col.estimatedCost": "~$",
  "logs.metric.tokPerSecTitle": "Số output token mỗi giây trên toàn bộ thời lượng request",

  "logs.metric.estimatedCostTitle": "Mức tương đương giá niêm yết của API, không phải là mức phí thực tế; không khả dụng với giá không khớp",

  "usage.cost.total": "Tương đương giá niêm yết API (phạm vi này)",

  "usage.cost.disclaimer": "Đây không phải biên lai thanh toán. Mức sử dụng thuê bao hoặc credit của provider có thể được áp dụng thay thế.",

  "usage.cost.unpricedNote": "Đã loại trừ {count} requests (không có giá hoặc mức sử dụng)",

  "logs.detail.section.basic": "Thông tin cơ bản",

  "logs.detail.route.section": "Quyết định định tuyến (Route decision)",

  "logs.detail.route.kind": "Loại định tuyến (Route kind)",

  "logs.detail.route.profile": "Profile",

  "logs.detail.route.selected": "Đã chọn",

  "logs.detail.route.candidates": "Ứng viên (Candidates)",

  "logs.detail.route.unknown": "Không có dấu vết định tuyến (route trace) nào được ghi lại cho request này (pre-trace row).",

  "logs.detail.section.performance": "Hiệu suất (Performance)",

  "logs.detail.section.cost": "Mức tương đương giá niêm yết API",

  "logs.detail.section.attempts": "Lượt thử kết hợp (Combo attempts)",

  "logs.detail.section.usage": "Mức sử dụng thô (Raw usage)",

  "logs.detail.ttft": "TTFT",

  "logs.detail.decodeTokPerSec": "Tốc độ decode (ước tính)",

  "logs.detail.reason.ttft_missing": "Không ghi nhận thời gian đến token đầu tiên (time-to-first-token) cho request này, nên không có cửa sổ decode nào để đo lường.",

  "logs.detail.reason.decode_window_too_short": "Cửa sổ sau token đầu tiên nhỏ hơn một giây, quá ngắn để ước tính tốc độ decode.",

  "logs.detail.costTotal": "Tương đương giá niêm yết",

  "logs.detail.totalTokens": "Tổng số tokens",

  "logs.detail.matchedKey": "Khoá giá trùng khớp (Matched price key)",

  "logs.detail.priceSource": "Nguồn giá (Price source)",

  "logs.detail.unavailableReason": "Lý do không khả dụng",

  "logs.detail.copyRequestId": "Sao chép ID request",

  "logs.detail.copied": "Đã sao chép",
  "logs.detail.source.jawcode": "Danh mục jawcode",

  "logs.detail.source.expected": "Giá niêm yết mong đợi (Expected price overlay)",

  "logs.detail.source.user": "Giá tuỳ chỉnh của provider (Provider-configured price overlay)",

  "logs.detail.verification.verified": "Đã xác minh (Verified)",

  "logs.detail.verification.derived": "Bắt nguồn từ model cơ sở (Derived from base model)",

  "logs.detail.attempt.target": "Nhà cung cấp / model",

  "logs.detail.attempt.reason": "Kết quả / lý do",

  "logs.detail.attempt.completed": "Đã hoàn thành",

  "logs.detail.attempt.e2eNote": "Chỉ số tok/s tổng thể (top-level) là tính từ đầu đến cuối (end-to-end); mỗi lần thử (attempt) sử dụng thời lượng riêng của nó.",

  "logs.detail.attempt.recovery.transient5xx": "Lỗi tạm thời 5xx (Transient 5xx)",

  "logs.detail.attempt.recovery.connectionReset": "Kết nối bị đặt lại (Connection reset)",

  "logs.detail.attempt.recovery.oauth401": "Xác thực lại OAuth (OAuth re-authentication)",

  "logs.detail.attempt.recovery.key429": "Khoá bị giới hạn tỷ lệ (Key rate-limited 429)",

  "logs.detail.attempt.recovery.rateLimit429": "Bị giới hạn tỷ lệ (Rate-limited 429)",

  "logs.detail.attempt.recovery.anthropicOauth429": "Xác thực Anthropic OAuth bị giới hạn tỷ lệ (429)",

  "logs.detail.attempt.recovery.image413": "Kích thước hình ảnh quá lớn (413)",

  "logs.detail.attempt.recovery.emptyCompletion": "Thử lại do hoàn thành rỗng (Empty completion retry)",

  "logs.detail.attempt.recovery.unknown": "Lý do khôi phục không rõ",

  "logs.detail.reason.usage_missing": "Mức sử dụng không được báo cáo.",

  "logs.detail.reason.usage_unsupported": "Provider này không báo cáo mức sử dụng.",

  "logs.detail.reason.output_missing": "Không có số lượng output token dương nào được báo cáo.",

  "logs.detail.reason.invalid_duration": "Thời lượng request không hợp lệ.",

  "logs.detail.reason.price_unmatched": "Không tìm thấy giá khớp.",

  "logs.detail.reason.invalid_cache_breakdown": "Chi tiết cache token không khớp với tổng số input token.",

  "logs.detail.reason.invalid_usage": "Mức sử dụng chứa giá trị token không hợp lệ.",

  "logs.detail.reason.combo_attempt_unavailable": "Ít nhất một lượt thử kết hợp (combo attempt) không thể định giá.",

  "logs.detail.estimate.usage_estimated": "Mức sử dụng của provider được ước tính.",

  "logs.detail.estimate.cache_detail_missing": "Chi tiết cache không khả dụng; đầu vào là ước tính giới hạn trên.",

  "logs.detail.estimate.expected_price_overlay": "Một giá niêm yết kỳ vọng (expected list price) đã xác minh được sử dụng.",

  "logs.detail.estimate.provider_cost_overlay": "Sử dụng giá tuỳ chỉnh do provider cấu hình.",

  "logs.detail.estimate.priority_lower_bound": "Giá Ưu tiên (Priority price) đã xác nhận không khả dụng; ước tính hiển thị là giới hạn dưới đã biết.",

  "logs.col.error": "Lỗi",
  "logs.col.upstreamReason": "Lý do upstream",

  "logs.col.duration": "Thời lượng",

  "logs.modelTooltip.model": "model",

  "logs.modelTooltip.resolvedModel": "model đã giải quyết (resolved model)",

  "logs.modelTooltip.requestedTier": "bậc (tier) được yêu cầu",

  "logs.modelTooltip.configuredTier": "bậc (tier) cấu hình",

  "logs.modelTooltip.responseTier": "bậc (tier) phản hồi",

  "logs.modelTooltip.supportsTier": "hỗ trợ tier",

  "logs.modelTooltip.tierOutcome.confirmed": "đã xác nhận",

  "logs.modelTooltip.tierOutcome.assumed": "giả định",

  "logs.modelTooltip.tierOutcome.downgraded": "đã hạ bậc",

  "logs.modelTooltip.tierOutcome.unknown": "không rõ",

  "logs.tokens.reported": "đã báo cáo",

  "logs.tokens.unreported": "không báo cáo",

  "logs.tokens.unsupported": "không hỗ trợ",

  "logs.tokens.estimated": "ước tính",

  "logs.tokens.input": "input",

  "logs.tokens.output": "output",

  "logs.tokens.cacheRead": "cache read (c)",

  "logs.tokens.cacheWrite": "cache write (w)",

  "logs.tokens.reasoning": "reasoning",

  "logs.tokens.noCache": "không có dữ liệu cache",

  "logs.tokens.contextTotal": "tổng ngữ cảnh hoạt động",

  "logs.tokens.noCacheNote": "provider này không báo cáo số lượng cache tokens",

  "logs.tokens.noCacheCursor": "Chi tiết bộ nhớ cache của Cursor không được báo cáo",

  "logs.tokens.noCacheCursorNote": "Cursor không tiết lộ số lượng cache read/write token; thông tin này chưa được biết (unknown), không phải là xác nhận cache miss",

  "logs.tokens.estimatedNote": "ước tính (provider không báo cáo mức sử dụng chính xác)",

  "logs.details": "Chi tiết",
  "logs.detailTitle": "Chi tiết request",

  "logs.detailRaw": "Mục log thô",


  // debug page
  "debug.title": "Gỡ lỗi",

  "debug.subtitle": "Chuẩn đoán (Diagnostics) về trích xuất mức sử dụng và luồng truyền (transport) của provider tuỳ chọn. Các request lỗi và 502 vẫn ở tab Logs.",

  "debug.debug": "Debug của provider",

  "debug.usage": "Trích xuất mức sử dụng",

  "debug.injection": "Log can thiệp (Injection log)",

  "debug.claude": "Claude đầu vào (Claude inbound)",

  "debug.claudeInbound.title": "Các request đầu vào từ Claude",

  "debug.claudeInbound.sub": "Những gì Claude Code/Desktop thực sự gửi (thinking, effort, metadata) — không có nội dung text của prompt nào được lưu.",

  "debug.claudeInbound.empty": "Chưa thu được request nào. Hãy gửi một tin nhắn từ Claude trong khi tính năng này được bật.",

  "debug.claudeInbound.time": "Thời gian",

  "debug.claudeInbound.endpoint": "Endpoint",

  "debug.claudeInbound.model": "Model",

  "debug.claudeInbound.none": "không có",

  "debug.reset": "Xoá các thay đổi runtime (runtime overrides)",

  "debug.refresh": "Làm mới",
  "debug.follow": "Theo dõi (Follow)",

  "debug.streamProvider": "Nhà cung cấp",

  "debug.streamUsage": "Mức sử dụng",
  "debug.streamInjection": "Sự can thiệp (Injection)",

  "debug.loading": "Đang tải cài đặt debug…",

  "debug.loadFailed": "Không thể tải cài đặt debug.",

  "debug.emptyTitle": "Ghi log debug đang tắt",

  "debug.empty": "Bật Provider debug hoặc Trích xuất mức sử dụng (Usage extraction) trong thẻ bên trên. Các dòng log sẽ xuất hiện ở đây sau khi bạn gửi một request qua proxy.",

  "debug.noLinesTitle": "Đang chờ dòng (Waiting for lines)",

  "debug.noLines.provider": "Tính năng Provider debug đang bật, nhưng nó chỉ ghi lại những bất thường trong quá trình truyền dữ liệu (dropped or malformed frames, và các sự kiện quay số/thử lại của Cursor). Một request không lỗi qua provider như Anthropic có thể không tạo ra dòng nào.",

  "debug.noLines.usage": "Trích xuất mức sử dụng đang bật nhưng chưa thu thập được dữ liệu. Gửi một chat/request thông qua Codex và log sẽ hiện ra ở đây.",

  "debug.noLines.injection": "Log can thiệp (Injection log) đang bật nhưng chưa thu thập được dữ liệu. Tính năng này ghi lại các can thiệp về hướng dẫn đa agent (multi-agent guidance injection) và quyết định nỗ lực trong các lượt cộng tác (collab) hoặc qua agent con.",


  // usage page
  "usage.title": "Mức sử dụng",
  "usage.subtitle": "Quản lý token cục bộ (local token accounting) từ proxy của bạn. Mức sử dụng bị thiếu sẽ không bao giờ hiển thị bằng 0 (zero).",

  "usage.loading": "Đang tải dữ liệu sử dụng…",

  "usage.empty": "Chưa có mức sử dụng nào được ghi lại. Gửi một request qua proxy để thấy hoạt động ở đây.",

  "usage.loadError": "Không thể tải dữ liệu sử dụng.",

  "usage.range.all": "Tất cả",
  "usage.range.available": "Lịch sử khả dụng",

  "usage.historyTruncated": "Số tổng chỉ bao gồm lịch sử có sẵn vì các dữ liệu sử dụng cũ hơn không được tải.",

  "usage.historyTruncatedWindow": "Các hàng được tải có thời gian bắt đầu (request start times) từ {start} đến {end}. Các mục file cũ hơn đã bị bỏ qua bởi giới hạn đọc (read limit), do đó bất kỳ phạm vi đã chọn nào cũng có thể không đầy đủ.",

  "usage.range.30d": "30 ngày",

  "usage.range.7d": "7 ngày",

  "usage.card.requests": "Yêu cầu",

  "usage.card.measured": "Đã đo lường (Measured)",

  "usage.card.reported": "Đã báo cáo (Reported)",

  "usage.card.totalTokens": "Tổng số tokens",

  "usage.card.cachedTokens": "Đọc cache (Cache reads)",

  "usage.card.cachedTokensHint": "Prompt tokens được phục vụ từ cache của provider (cache reads). Cache writes sẽ hiển thị bên dưới nếu có.",

  "usage.card.cacheWriteTokens": "ghi cache (cache writes)",

  "usage.card.coverage": "Độ phủ (Coverage)",

  "usage.card.activeDays": "Số ngày hoạt động",

  "usage.section.heatmap": "Hoạt động hàng ngày",

  "usage.section.overview": "Tổng quan",
  "usage.section.models": "Models",

  "usage.section.providers": "Nhà cung cấp",
  "usage.section.coverage": "Chi tiết độ phủ (Coverage breakdown)",

  "usage.workspace.report": "Báo cáo sử dụng",

  "usage.workspace.sections": "Các phần sử dụng",

  "usage.coverage.measured": "Đã đo",

  "usage.coverage.reported": "Provider báo cáo",

  "usage.coverage.estimated": "Ước tính",

  "usage.coverage.note": "Các mục đo lường (Measured) bao gồm số lượng token ước tính và được báo cáo bởi provider. Các requests không có báo cáo hoặc không được hỗ trợ vẫn được theo dõi nhưng không bao giờ bị biến thành 0 token.",

  "usage.search.models": "Tìm kiếm models…",

  "usage.col.requests": "Yêu cầu",

  "usage.col.measured": "Đã đo",

  "usage.col.reported": "Đã báo cáo",

  "usage.col.tokens": "Tokens",

  "usage.col.share": "Tỷ trọng",

  "usage.heatmap.less": "Ít",

  "usage.heatmap.more": "Nhiều",

  "usage.dayMon": "T2",

  "usage.dayWed": "T4",

  "usage.dayFri": "T6",

  "usage.heatmap.tooltipTokens": "{tokens} token",

  "usage.heatmap.tooltipRequests": "{requests} yêu cầu",


  "nav.storage": "Lưu trữ",
  "storage.title": "Lưu trữ",
  "storage.subtitle": "Xem những gì đang chiếm dụng dung lượng trong CODEX_HOME. Việc dọn dẹp sẽ không bao giờ đụng đến các phiên (sessions) đang hoạt động.",

  "storage.loading": "Đang quét lưu trữ…",

  "storage.empty": "CODEX_HOME trống hoặc bị thiếu — không có gì để báo cáo.",

  "storage.error": "Quét lưu trữ thất bại. Vui lòng kiểm tra CODEX_HOME có trỏ đến một thư mục hợp lệ không.",

  "storage.refresh": "Quét lại (Rescan)",

  "storage.rescanned": "Quét hoàn tất.",

  "storage.card.total": "Tổng kích thước",

  "storage.card.files": "Tệp (Files)",

  "storage.card.home": "CODEX_HOME",

  "storage.snapshot.lastScan": "Lần quét trước",

  "storage.snapshot.scanning": "Đang quét…",

  "storage.snapshot.unavailable": "Chưa có lượt quét nào.",

  "storage.cleanupCard.title": "Giải phóng không gian lưu trữ",

  "storage.cleanupCard.tabs": "Tuỳ chọn dọn dẹp",

  "storage.cleanupCard.tab.policy": "Chính sách (Policy)",

  "storage.cleanupCard.tab.quarantine": "Cách ly (Quarantine)",

  "storage.cleanup.noArchives": "Không có phiên lưu trữ (archived sessions) nào để dọn dẹp.",

  "storage.section.buckets": "Buckets",

  "storage.section.largest": "Các tệp lớn nhất",

  "storage.workspace.overview": "Tổng quan",
  "storage.workspace.selectBucket": "Chọn một bucket từ danh sách để xem chi tiết.",

  "storage.col.bucket": "Bucket",

  "storage.col.size": "Kích thước",

  "storage.col.files": "Số tệp",

  "storage.col.oldest": "Cũ nhất",

  "storage.col.newest": "Mới nhất",

  "storage.col.rows": "Hàng trong DB (DB rows)",

  "storage.rows.unknown": "không rõ (đang bị khoá)",

  "storage.bucket.sessions": "Các phiên hoạt động (Active sessions)",

  "storage.bucket.archived_sessions": "Các phiên đã lưu trữ (Archived sessions)",

  "storage.bucket.logs_db": "Cơ sở dữ liệu logs",

  "storage.bucket.state_db": "Cơ sở dữ liệu state",

  "storage.bucket.attachments": "Tệp đính kèm (Attachments)",

  "storage.bucket.deletion_manifests": "Manifests xoá",

  "storage.bucket.other": "Khác",

  "storage.cleanup.title": "Dọn dẹp lưu trữ (Archived cleanup)",

  "storage.cleanup.help": "Xoá các phiên đã lưu trữ cũ nhất theo tỷ lệ phần trăm. Các phiên hoạt động không bao giờ bị đụng tới. Cách ly là mặc định — các tệp sẽ chuyển vào CODEX_HOME/.trash.",

  "storage.cleanup.slider": "Phần trăm cũ nhất của lưu trữ",

  "storage.cleanup.percent": "{percent}%",

  "storage.cleanup.preset": "{percent}",

  "storage.cleanup.preview": "Xem trước",

  "storage.cleanup.confirmTitle": "Xác nhận dọn dẹp lưu trữ",

  "storage.cleanup.confirmBody": "Thao tác này sẽ xử lý {count} tệp lưu trữ (~{size}), chiếm {percent}% cũ nhất.",

  "storage.cleanup.moreFiles": "…và {n} tệp khác",

  "storage.cleanup.permanent": "Xoá vĩnh viễn (bỏ qua cách ly)",

  "storage.cleanup.permanentWarn": "Thao tác xoá vĩnh viễn không thể hoàn tác.",

  "storage.cleanup.quarantineNote": "Các tệp sẽ được di chuyển vào .trash thuộc CODEX_HOME. Bạn có thể khôi phục chúng từ tab Cách ly.",

  "storage.cleanup.cancel": "Hủy",
  "storage.cleanup.confirmQuarantine": "Cách ly",

  "storage.cleanup.confirmPermanent": "Xoá vĩnh viễn",

  "storage.cleanup.doneQuarantine": "Đã cách ly {count} tệp ({size}).",

  "storage.cleanup.donePermanent": "Đã xoá vĩnh viễn {count} tệp ({size}).",

  "storage.cleanup.skippedReferenced": "Đã bỏ qua {count} tệp đang được tham chiếu.",

  "storage.cleanup.previewFailed": "Xem trước thất bại.",

  "storage.cleanup.cleanupFailed": "Dọn dẹp thất bại.",

  "storage.cleanup.err.codex_busy": "Codex đang sử dụng state.sqlite — hãy thử lại sau khi thoát Codex.",

  "storage.cleanup.err.stale_preview": "Các tệp lưu trữ đã thay đổi kể từ khi xem trước — hãy chạy lại tính năng Xem trước (Preview).",

  "storage.cleanup.err.restore_pending_overlap": "Các lưu trữ đã chọn bị trùng với tiến trình khôi phục rác chưa hoàn tất — hãy kết thúc hoặc thử khôi phục lại trước.",

  "storage.cleanup.err.referenced_history": "Các lưu trữ đã chọn vẫn đang được tham chiếu bởi lịch sử phân nhánh (forked) hoặc phân trang (paginated).",

  "storage.cleanup.err.invalid_digest": "Mã xác nhận xem trước (Preview digest) bị thiếu hoặc không hợp lệ.",

  "storage.cleanup.err.invalid_mode": "Chế độ dọn dẹp phải là cách ly (quarantine) hoặc xoá vĩnh viễn (permanent).",

  "storage.cleanup.err.fs_failed": "Dọn dẹp hệ thống tệp thất bại. Một số thay đổi có thể đã được áp dụng — kiểm tra CODEX_HOME/.trash và bất kỳ đường dẫn khôi phục nào được hiển thị.",

  "storage.cleanup.err.fs_failed_trash": "Dọn dẹp hệ thống tệp thất bại. Một số thay đổi có thể đã được áp dụng — kiểm tra {trashDir} và manifest.json để xem tệp có thể khôi phục.",

  "storage.cleanup.err.db_reconcile_failed": "Không thể cập nhật cơ sở dữ liệu state của Codex.",

  "storage.cleanup.err.cleanup_failed": "Dọn dẹp thất bại.",


  "storage.trash.title": "Cách ly (Quarantine)",

  "storage.trash.help": "Các phiên đã lưu trữ (Archived sessions) được di chuyển vào CODEX_HOME/.trash. Quá trình Khôi phục sẽ đặt các tệp JSONL và dữ liệu hàng (thread rows) trở lại.",

  "storage.trash.empty": "Không có mục cách ly nào.",

  "storage.trash.loading": "Đang tải vùng cách ly…",

  "storage.trash.col.when": "Thời gian cách ly",

  "storage.trash.col.files": "Tệp",

  "storage.trash.col.size": "Kích thước",

  "storage.trash.col.mode": "Chế độ",

  "storage.trash.col.id": "Mục (Entry)",

  "storage.trash.restore": "Khôi phục",

  "storage.trash.confirmTitle": "Khôi phục mục cách ly?",

  "storage.trash.confirmBody": "Khôi phục {count} tệp (~{size}) từ {id} về lại các phiên đã lưu trữ (archived sessions).",

  "storage.trash.cancel": "Hủy",
  "storage.trash.confirmRestore": "Khôi phục",

  "storage.trash.done": "Đã khôi phục {count} tệp ({size}).",

  "storage.trash.restoreFailed": "Khôi phục thất bại.",

  "storage.trash.listFailed": "Không thể lấy danh sách các mục cách ly.",

  "storage.trash.mode.quarantine": "cách ly",

  "storage.trash.mode.permanent": "xoá vĩnh viễn (chưa hoàn thành)",

  "storage.trash.err.codex_busy": "Codex đang sử dụng state.sqlite — hãy thử lại sau khi thoát Codex.",

  "storage.trash.err.invalid_trash": "Id của mục trong thùng rác bị thiếu hoặc không hợp lệ.",

  "storage.trash.err.missing_trash": "Không tìm thấy mục thùng rác.",

  "storage.trash.err.dest_exists": "Đích khôi phục đã tồn tại — hãy xoá hoặc đổi tên tệp lưu trữ và thử lại.",

  "storage.trash.err.fs_failed": "Khôi phục hệ thống tệp thất bại. Một số tệp có thể đã được khôi phục — hãy kiểm tra archived_sessions và .trash.",

  "storage.trash.err.db_reconcile_failed": "Không thể khôi phục hàng (rows) của cơ sở dữ liệu Codex state.",

  "storage.trash.err.storage_mutation_busy": "Có một quá trình dọn dẹp hoặc khôi phục lưu trữ khác đang chạy — vui lòng thử lại sau.",

  "storage.trash.err.restore_failed": "Khôi phục thất bại.",

  "storage.trash.err.restore_worker_timeout": "Quá trình khôi phục diễn ra quá lâu (hơn 10 phút) và đã bị dừng lại.",

  "storage.trash.err.restore_worker_aborted": "Quá trình khôi phục đã bị huỷ trong lúc tắt máy (shutdown).",

  "storage.trash.err.restore_worker_failed": "Worker khôi phục bị treo hoặc bị lỗi ngoài dự kiến.",

  "storage.policy.title": "Chính sách dọn dẹp tự động",

  "storage.policy.help": "Làm sạch hàng loạt (batch cleanup) tuỳ chọn khi số phiên lưu trữ vượt quá ngưỡng nhất định. Mặc định là tắt — không bao giờ tự động bật.",

  "storage.policy.loading": "Đang tải chính sách…",

  "storage.policy.loadFailed": "Không thể tải chính sách dọn dẹp.",

  "storage.policy.saveFailed": "Không thể lưu chính sách dọn dẹp.",

  "storage.policy.runFailed": "Lỗi khi chạy chính sách (Policy run failed).",

  "storage.policy.alreadyRunning": "Một lượt chạy chính sách dọn dẹp (cleanup policy run) đang được thực thi.",

  "storage.policy.invalid": "Giá trị của chính sách không hợp lệ.",

  "storage.policy.enabled": "Bật dọn dẹp tự động",

  "storage.policy.enabledHint": "Mặc định đang tắt. Khi bật, nó chỉ chạy theo lịch mà bạn đã chọn (hoặc khi bấm Chạy ngay bây giờ).",

  "storage.policy.threshold": "Khi kích thước lưu trữ vượt quá (GiB)",

  "storage.policy.trigger": "Kích hoạt (Trigger)",

  "storage.policy.target": "Mục tiêu dọn dẹp",

  "storage.policy.targetPercent": "Xoá phần trăm cũ nhất của phần lưu trữ (%)",

  "storage.policy.targetReduce": "Giảm dung lượng lưu trữ xuống (GiB)",

  "storage.policy.thresholdInc": "Tăng ngưỡng",

  "storage.policy.thresholdDec": "Giảm ngưỡng",

  "storage.policy.percentInc": "Tăng tỷ lệ phần trăm",

  "storage.policy.percentDec": "Giảm tỷ lệ phần trăm",

  "storage.policy.reduceInc": "Tăng kích thước được giảm xuống",

  "storage.policy.reduceDec": "Giảm kích thước được giảm xuống",

  "storage.policy.schedule": "Lịch biểu (Schedule)",

  "storage.policy.schedule.manual": "Chỉ thủ công (Manual only)",

  "storage.policy.schedule.startup": "Khi khởi động proxy",

  "storage.policy.schedule.daily": "Hàng ngày",

  "storage.policy.schedule.weekly": "Hàng tuần",

  "storage.policy.mode": "Chế độ xoá (Deletion mode)",

  "storage.policy.mode.quarantine": "Cách ly (mặc định)",

  "storage.policy.mode.permanent": "Xoá vĩnh viễn",

  "storage.policy.permanentWarn": "Chế độ xoá vĩnh viễn không thể hoàn tác. Khuyến khích sử dụng chế độ cách ly trừ khi bạn chắc chắn.",

  "storage.policy.lastRun": "Chạy lần cuối (Last run)",

  "storage.policy.lastRunDetail": "Đã xoá {count} · đã giải phóng {size}",

  "storage.policy.nextRun": "Chạy lần tiếp",

  "storage.policy.never": "Không bao giờ",
  "storage.policy.save": "Lưu",
  "storage.policy.runNow": "Chạy ngay (Run now)",

  "storage.policy.running": "Đang chạy…",

  "storage.policy.saved": "Chính sách đã được lưu.",

  "storage.policy.skippedDisabled": "Chính sách đang tắt — vui lòng bật nó lên trước.",

  "storage.policy.skippedUnder": "Kích thước lưu trữ vẫn dưới ngưỡng — không cần phải làm gì.",

  "storage.policy.skippedEmpty": "Không có ứng viên lưu trữ nào phù hợp với mục tiêu.",

  "storage.policy.doneQuarantine": "Chính sách đã cách ly {count} tệp ({size}).",

  "storage.policy.donePermanent": "Chính sách đã xoá vĩnh viễn {count} tệp ({size}).",

  "storage.policy.metadataSaveWarning": "Phiên chạy chính sách đã kết thúc, nhưng metadata lập lịch của nó không thể lưu được.",


  // add-provider modal
  "modal.addNamed": "Thêm: {label}",

  "modal.add": "Thêm provider",

  "modal.search": "Tìm Provider…",
  "modal.logInWith": "Đăng nhập bằng {label}",

  "modal.waitingBrowser": "Đang đợi trình duyệt…",

  "modal.providerName": "Tên provider",

  "modal.adapter": "Adapter",

  "modal.baseUrl": "Base URL",

  "modal.endpoint": "Endpoint",

  "modal.endpoint.tokenPlan": "Gói token",

  "modal.endpoint.payAsYouGo": "Dùng bao nhiêu trả bấy nhiêu",

  "modal.endpoint.custom": "Tùy chỉnh",
  "modal.defaultModel": "Model mặc định (tuỳ chọn)",

  "modal.allowPrivateNetwork": "Cho phép mạng nội bộ/cá nhân",

  "modal.allowPrivateNetworkHint": "Chỉ bật cho các provider tự host có chủ đích. Các endpoint metadata vẫn bị chặn.",

  "modal.nameRequired": "Bắt buộc phải có tên provider",

  "modal.baseUrlRequired": "Bắt buộc phải có Base URL",

  "modal.networkError": "Lỗi mạng — proxy có đang chạy không?",

  "modal.loginFailStart": "Không thể bắt đầu đăng nhập",

  "modal.waitingLogin": "Đang đợi đăng nhập trên trình duyệt…",

  "modal.loggingIn": "Đang đăng nhập…",

  "modal.loginTimeout": "Đăng nhập quá thời gian — vui lòng thử lại.",

  "modal.back": "Quay lại",
  "modal.badge.oauth": "OAuth",

  "modal.customProvider": "Provider tuỳ chỉnh",

  "modal.failedStatus": "Thất bại ({status})",

  "modal.loginError": "Lỗi đăng nhập: {error}",

  "modal.badge.codexLogin": "Đăng nhập Codex",

  "modal.badge.local": "Cục bộ",
  "modal.badge.apiKey": "API key",

  "modal.badge.direct": "Trực tiếp",

  "modal.badge.pool": "Pool",

  "modal.badge.free": "Miễn phí",

  "modal.badge.sponsor": "Tài trợ",

  "pws.sponsor.orcaTitle": "Một model cho mọi prompt",

  "pws.sponsor.orcaDescription": "Gateway tương thích OpenAI với tính năng định tuyến thích ứng và tự động chuyển đổi dự phòng.",

  "pws.sponsor.packyTitle": "Claude Code, Codex và Gemini tại một nơi",

  "pws.sponsor.packyDescription": "Relay API cho các công cụ AI lập trình của bạn. Bắt đầu với token nhóm Codex.",

  "pws.sponsor.visit": "Khám phá {provider}",

  "pws.sponsor.console": "Mở console",

  "modal.invalidPreset": "Preset của provider tích hợp này bị thiếu. Hãy khởi động lại proxy và thử lại.",

  "modal.freeTierTitle": "Gói miễn phí",

  "modal.freeTierDefault": "Không cần API key. Có thể sử dụng ngay.",

  "modal.tab.accounts": "Tài khoản",
  "modal.tab.free": "Miễn phí",

  "modal.tab.paid": "Trả phí",

  "modal.accountsHint": "Đăng nhập vào tài khoản ChatGPT/Codex, các provider OAuth, và tài khoản API key tại đây. OpenAI đã được tích hợp sẵn — vui lòng đăng nhập thay vì thêm mới.",

  "modal.accountsCodexAuthLink": "Xác thực Codex",

  "modal.notListed": "Không tìm thấy provider? Thêm provider tuỳ chỉnh",

  "modal.catalogLoading": "Đang tải danh mục…",

  "modal.accountLogin": "Đăng nhập",

  "modal.accountLogout": "Đăng xuất",

  "modal.accountAdd": "Thêm tài khoản",

  "modal.accountManage": "Quản lý",

  "modal.accountCodexPool": "Pool tài khoản ChatGPT",

  "modal.accountLoggedIn": "Đã đăng nhập",

  "modal.accountLoggedOut": "Chưa đăng nhập",

 "quota.fiveHourLimit": "Giới hạn 5 giờ",

  "quota.ageMinutes": "{n} phút",

  "quota.ageHours": "{n} giờ",

  "quota.ageDays": "{n} ngày",

  "quota.observedAgo": "Ghi nhận {age} trước",

  "quota.observedHint": "Meta chỉ báo cáo mức sử dụng trong quá trình phản hồi stream, vì vậy đây là giá trị cuối cùng ghi nhận được, không phải số liệu thời gian thực.",

  "quota.weeklyLimit": "Giới hạn hàng tuần",

  "quota.monthlyLimit": "Giới hạn 30 ngày",

  "quota.cursorFirstParty": "Các model first-party",

  "quota.cursorApiUsage": "Mức sử dụng API",

  "quota.totalSubscriptionCredits": "Tổng credit gói đăng ký",

  "quota.creditsBalance": "Số dư credit",

  "quota.creditsPeriodEnds": "Chu kỳ thanh toán kết thúc vào {date}",

  "quota.usedPercent": "Đã dùng {pct}%",

  "quota.limitReached": "Đã đạt giới hạn",

  "quota.resetsToday": "Đặt lại hôm nay lúc {time}",

  "quota.resetsTomorrow": "Đặt lại ngày mai lúc {time}",

  "quota.resetsAt": "Đặt lại vào {when}",

  "quota.resetsRelativeMinutes": "Đặt lại sau {n} phút",

  "quota.resetsRelativeHours": "Đặt lại sau {n} giờ",

  "pws.status.ready": "Sẵn sàng",

  "pws.status.needsSetup": "Cần thiết lập",

  "pws.status.needsAttention": "Cần chú ý",

  "pws.auth.chatgptPassthrough": "ChatGPT passthrough",

  "pws.auth.noKey": "Không cần key",

  "pws.freeTitle": "Giá miễn phí (vẫn có thể yêu cầu key)",

  "pws.localTitle": "Runtime cục bộ",

  "pws.modelCountOne": "1 model",

  "pws.modelCount": "{count} model",

  "pws.rail.suffixDefault": " · mặc định",

  "pws.rail.suffixLocal": " · cục bộ",

  "pws.rail.suffixFree": " · miễn phí",

  "pws.rail.selectAria": "Chọn {name} — {status}{suffix}",

  "pws.searchPlaceholder": "Tìm Provider…",
  "pws.filterAria": "Lọc các provider",

  "pws.providerFiltersAria": "Bộ lọc provider",

  "pws.filters": "Bộ lọc",

  "pws.filterStatus": "Trạng thái",
  "pws.pricing": "Định giá",

  "pws.paid": "Trả phí",

  "pws.filterType": "Loại",

  "pws.type.cloud": "Cloud",

  "pws.type.local": "Cục bộ",
  "pws.type.selfHosted": "Tự host",

  "pws.type.login": "Đăng nhập",

  "pws.sort": "Sắp xếp",

  "pws.sortProvidersAria": "Sắp xếp các provider",

  "pws.sort.az": "A–Z",

  "pws.sort.za": "Z–A",

  "pws.sort.freePaid": "Miễn phí trước",

  "pws.sort.paidFree": "Trả phí trước",

  "pws.sort.accountsFirst": "Tài khoản trước",

  "pws.resetAll": "Đặt lại tất cả",

  "pws.providerList": "Danh sách provider",

  "pws.providersAria": "Nhà cung cấp",
  "pws.groupReady": "Sẵn sàng ({count})",

  "pws.groupNeedsSetup": "Cần thiết lập ({count})",

  "pws.groupDisabled": "Đã vô hiệu hoá ({count})",

  "pws.noSearchResults": "Không có provider nào khớp với tìm kiếm của bạn.",

  "pws.noMatchFilters": "Không có provider nào khớp với các bộ lọc.",

  "pws.noProvidersConfigured": "Chưa có provider nào được cấu hình.",

  "pws.workspaceMainAria": "Chi tiết provider",

  "pws.detailComingSoon": "Chế độ xem chi tiết sắp ra mắt — sử dụng chế độ xem cổ điển để quản lý provider này.",

  "pws.selectPrompt": "Chọn một provider từ danh sách.",

  "pws.connectFirst": "Kết nối provider đầu tiên của bạn",

  "pws.empty.browseFree": "Duyệt các provider miễn phí",

  "pws.empty.browseFreeDesc": "Bắt đầu mà không cần gói đăng ký",

  "pws.empty.connectAccount": "Kết nối một tài khoản",

  "pws.empty.connectAccountDesc": "Sử dụng đăng nhập ChatGPT hoặc provider của bạn",

  "pws.empty.addEndpoint": "Thêm một endpoint",

  "pws.empty.addEndpointDesc": "Base URL và API key tuỳ chỉnh",

  "pws.tab.overview": "Tổng quan",
  "pws.tab.models": "Models",

  "pws.tab.usage": "Mức sử dụng",
  "pws.tab.accounts": "Tài khoản",
  "pws.tab.settings": "Cài đặt",
  "pws.connection": "Kết nối",

  "pws.status.connected": "Đã kết nối",

  "pws.attentionTitle": "Cần chú ý",

  "pws.attention.reauth": "Tài khoản đang hoạt động cần xác thực lại",

  "pws.attention.reauthForward": "Tài khoản Codex đang hoạt động cần xác thực lại — hãy mở mục Accounts để khắc phục",

  "pws.attention.missingCredentials": "Thiếu thông tin xác thực",

  "pws.cell.auth": "Xác thực",

  "pws.cell.note": "Ghi chú",

  "pws.cell.defaultModel": "Model mặc định",

  "pws.statsAria": "Thống kê provider",

  "pws.statsTitle": "Thống kê",

  "pws.stats.totalRequests": "Yêu cầu (30 ngày)",

  "pws.stats.totalTokens": "Token (30 ngày)",

  "pws.stats.quotaUpdated": "Đã cập nhật hạn mức",

  "pws.stats.quotaTracked": "Giới hạn tốc độ được theo dõi trong tab Usage.",

  "pws.stats.source": "Nguồn",

  "pws.usageLast30d": "Mức sử dụng (30 ngày qua)",

  "pws.estimatedCost": "Chi phí ước tính",

  "pws.costDisclaimer": "Ước tính theo giá niêm yết của API, không phải là mức phí thực tế.",

  "pws.unresolvedRequestedModel": "Bao gồm cả mức sử dụng model được yêu cầu chưa giải quyết",

  "pws.currentAccountUsage": "Mức sử dụng tài khoản hiện tại",

  "pws.quotaUnsupported": "Tra cứu hạn mức không được hỗ trợ cho tài khoản này.",

  "pws.quotaUnobserved": "Chưa có dữ liệu sử dụng nào được ghi nhận.",

  "pws.quotaCheckCompleted": "Đã hoàn thành kiểm tra hạn mức",

  "pws.modelBreakdown": "Chi tiết theo model",

  "pws.col.model": "Model",

  "pws.col.cost": "Chi phí ước tính",

  "pws.col.tokens": "Tokens",

  "pws.col.requests": "Yêu cầu",

  "pws.col.share": "Tỷ lệ",

  "pws.tokenInput": "Đầu vào",

  "pws.tokenOutput": "Đầu ra",

  "pws.metricRequests": "yêu cầu",

  "pws.metricTokens": "tokens",

  "pws.usageUnavailable": "Chưa có mức sử dụng nào được ghi nhận.",

  "pws.rateLimits": "Giới hạn tốc độ",

  "pws.quotaUnavailable": "Không có dữ liệu hạn mức cho provider này.",

  "pws.accountQuotaUnavailable": "Dữ liệu giới hạn tốc độ tạm thời không khả dụng; đang hiển thị các giá trị cuối cùng được biết đến (nếu có).",

  "pws.selected": "Đã chọn",

  "pws.copyModelId": "Sao chép ID",

  "pws.modelCopied": "Đã sao chép!",

  "pws.modelsAvailable": "{count} model khả dụng",

  "pws.modelSearchPlaceholder": "Lọc các model…",

  "pws.modelsLoading": "Đang tải các model…",

  "pws.modelsLoadFailed": "Không thể tải các model.",

  "pws.modelsNeedsReauth": "Tài khoản cần đăng nhập lại trước khi tính năng khám phá model trực tiếp có thể hoạt động. Tạm thời hiển thị các model đã cấu hình.",

  "pws.modelsConfiguredFallback": "Đang hiển thị các model đã cấu hình (tính năng khám phá trực tiếp không khả dụng).",

  "pws.modelsTruncated": "Đang hiển thị {shown} model đầu tiên trong tổng số {total} model. Hãy sử dụng bộ lọc để thu hẹp danh sách.",

  "pws.retry": "Thử lại",
  "pws.noModels": "Không phát hiện model nào cho provider này.",

 "pws.noModelMatch": "Không có model nào khớp với bộ lọc.",

  "pws.adapterBaseRequired": "Bắt buộc phải có Adapter và Base URL.",

  "pws.addAccount": "Thêm tài khoản",

  "pws.addKey": "Thêm API key",

  "pws.apiKeys": "API Keys",

  "pws.authMode": "Chế độ xác thực",

  "pws.availableAccounts": "Các tài khoản khả dụng",
  "pws.accountOrdinal": "Tài khoản {count}",

  "pws.accountsLoading": "Đang tải các tài khoản…",

  "pws.accountsLoadFailed": "Không thể tải các tài khoản.",

  "pws.retryAccounts": "Thử lại",
  "pws.noAccounts": "Chưa có tài khoản nào được kết nối.",

  "pws.cockpitImportDescription": "Nhập tệp xuất Cockpit Tools Antigravity dạng JSON từ thiết bị này. Nội dung tệp sẽ không được hiển thị.",

  "pws.cockpitImportFileLabel": "Tệp xuất JSON từ Cockpit Tools Antigravity",

  "pws.cockpitImportChooseFile": "Chọn tệp JSON",

  "pws.cockpitImporting": "Đang nhập…",

  "pws.cockpitImportInvalid": "Tệp đã chọn không phải là tệp xuất JSON hợp lệ hoặc có kích thước quá lớn.",

  "pws.cockpitImportFailed": "Không thể hoàn thành việc nhập tài khoản.",

  "pws.cockpitImportComplete": "Đã nhập xong: {imported} được nhập, {updated} được cập nhật, {failed} thất bại, {unsupported} không được hỗ trợ.",

  "pws.accountSwitching": "Đang chuyển…",

  "pws.accountCurrent": "Tài khoản hiện tại",

  "pws.defaultModelNone": "Không có (sử dụng mặc định của provider)",

  "pws.discardSettings": "Huỷ bỏ",

  "pws.jsonEditorDesc": "Chỉnh sửa config dạng JSON thô của provider. Các thay đổi sẽ được lưu ngay lập tức.",

  "pws.jsonEditorTitle": "Trình chỉnh sửa JSON — {name}",

  "pws.jsonRestore": "Khôi phục",

  "pws.jsonSave": "Lưu",
  "pws.loggedInTitle": "Đã đăng nhập",

  "pws.notLoggedInTitle": "Chưa đăng nhập",

  "pws.note": "Ghi chú",

  "pws.allowPrivateNetwork": "Cho phép mạng nội bộ/cá nhân",

  "pws.liveModels": "Khám phá các model từ provider",

  "pws.liveModelsDesc": "Lấy danh mục model trực tiếp từ provider. Hãy tắt tuỳ chọn này nếu chỉ muốn sử dụng các model đã cấu hình/tĩnh.",

  "pws.xaiChatOptIn": "Sử dụng Chat Completions cho Grok 4.5 và 4.6",

  "pws.xaiChatOptInDesc": "Tắt để chọn Responses. Các yêu cầu OAuth Responses sử dụng tuỳ chọn này theo mặc định. Các model Grok khác và hành vi của gói không bị ảnh hưởng.",

  "pws.xaiChatOptInMixed": "Chỉ có một model sử dụng Chat.",

  "pws.cursorTransport": "Cursor transport",

  "pws.cursorTransportHttp2": "HTTP/2 (mặc định)",

  "pws.cursorTransportHttp1": "HTTP/1.1 (tương thích với proxy)",

  "pws.cursorTransportDesc": "Sử dụng HTTP/1.1 khi proxy của bạn không thể truyền stream HTTP/2 của Cursor một cách đáng tin cậy.",

  "pws.optionalPlaceholder": "Tuỳ chọn",

  "pws.providerId": "ID provider",

  "pws.reauth": "Cần xác thực lại",

  "pws.reauthenticate": "Xác thực lại",

  "pws.copyDoctor": "Sao chép ocx doctor",

  "pws.doctorCopied": "Đã sao chép",
  "pws.doctorCopyUnavailable": "Clipboard không khả dụng",

  "pws.healthCooldownHint": "Đợi cho đến khi thời gian chờ kết thúc. Không thăm dò tài khoản này ngay bây giờ.",

  "pws.healthLabel.rateLimited": "Bị giới hạn tốc độ",

  "pws.healthLabel.quotaLimited": "Bị giới hạn hạn mức",

  "pws.healthLabel.reauthRequired": "Yêu cầu xác thực lại",

  "pws.healthLabel.refreshFailed": "Làm mới thất bại",

  "pws.healthLabel.metadataMismatch": "Metadata không khớp",

  "pws.healthLabel.validationPending": "Đang chờ xác thực",

  "pws.healthSummary.validationPending": "{provider} {account}: được đăng ký trong khi bị giới hạn hạn mức. Sau khi hạn mức phục hồi, hãy làm mới hạn mức để chạy một yêu cầu xác thực nhỏ. Định tuyến sẽ bị vô hiệu hoá cho đến khi thành công.",

  "pws.healthLabel.credentialConflict": "Xung đột thông tin xác thực",

  "pws.healthSummary.rateLimited": "{provider} {account}: bị giới hạn tốc độ cho đến {until}. Quá trình định tuyến cho tài khoản này sẽ bị tạm dừng cho đến lúc đó.",

  "pws.healthSummary.quotaLimited": "{provider} {account}: bị giới hạn hạn mức cho đến {until}. Quá trình định tuyến cho tài khoản này sẽ bị tạm dừng cho đến lúc đó.",

  "pws.healthSummary.reauthRequired": "{provider} {account}: yêu cầu xác thực lại.",

  "pws.healthSummary.credentialConflict": "{provider} {account}: có xung đột thông tin xác thực.",

  "pws.healthSummary.metadataMismatch": "{provider} {account}: metadata không khớp.",

  "pws.healthSummary.staleCredentials": "{provider} {account}: thông tin xác thực không đầy đủ.",

  "pws.removeConfirm": "Xóa",
  "pws.removeConfirmBody": "Xoá provider \\\"{name}\\\"? Hành động này không thể hoàn tác.",

  "pws.removeDefaultConfirmBody": "Xoá provider mặc định \\\"{name}\\\"? \\\"{defaultProvider}\\\" sẽ trở thành provider mặc định. Hành động này không thể hoàn tác.",

  "pws.removeConfirmTitle": "Xóa Provider",
  "pws.saveSettings": "Lưu",
  "pws.pacingTitle": "Pacing của yêu cầu",

  "pws.pacingDesc": "Đồng đều trì hoãn thời điểm bắt đầu yêu cầu ra ngoài cho provider này. Các phản hồi stream có thể chồng chéo.",

  "pws.pacingEnabled": "Đã bật",
  "pws.pacingRpm": "Yêu cầu mỗi phút",

  "pws.pacingRpmUnit": "RPM",

  "pws.pacingDelay": "Khoảng thời gian tối thiểu (ms)",

  "pws.pacingSlowerWins": "Giới hạn provider chậm hơn sẽ được ưu tiên. Ghi đè model chỉ có thể làm tăng thêm độ trễ.",

  "pws.pacingQueued": "đã xếp hàng",

  "pws.pacingNextSlot": "cho đến slot tiếp theo",

  "pws.pacingLastModel": "model cuối cùng",

  "pws.pacingNone": "Không có",
  "pws.pacingModelOverrides": "Ghi đè model",

  "pws.pacingModel": "Model",

  "pws.pacingAdd": "Thêm ghi đè",

  "pws.pacingRemove": "Xóa",
  "pws.pacingRemoveModel": "Xoá ghi đè pacing yêu cầu cho {model}",

  "pws.pacingRuleRequired": "Chỉ bật pacing yêu cầu sau khi đã thiết lập giới hạn provider hoặc một ghi đè model.",

  "pws.saving": "Đang lưu…",

  "pws.settingsSaved": "Đã lưu cài đặt.",

  "pws.accountModeSaved": "Đã lưu chế độ tài khoản.",

  "pws.accountModeFailed": "Không thể chuyển chế độ tài khoản.",

  "pws.accountModeConfirm": "Chuyển chế độ tài khoản OpenAI? Các cuộc hội thoại đang chạy sẽ được gán lại cho bộ tài khoản của chế độ khác, và mức sử dụng hạn mức sẽ được theo dõi trên chế độ mới.",

  "pws.settingsUnsavedBar": "Bạn có các thay đổi chưa lưu.",

  "pws.unsavedLeaveBody": "Bạn có các thay đổi chưa lưu. Lưu chúng lại trước khi rời đi?",

  "pws.unsavedLeaveTitle": "Thay đổi chưa lưu",

  "pws.attentionRequired": "Cần sự chú ý",

  "pws.attentionAria": "{name}: {reason}",

  "pws.missingCredentials": "Thiếu thông tin xác thực",

  "pws.editJsonDesc": "Chỉnh sửa config proxy thô dưới dạng JSON",

  "pws.updatesUnavailable": "Các bản cập nhật của provider hiện không khả dụng.",

  "pws.dashboard.title": "Tổng quan các provider",

  "pws.dashboard.subtitle": "Quản lý tất cả các model provider của bạn tại một nơi.",

  "pws.dashboard.rateLimits": "GIỚI HẠN TỐC ĐỘ",

  "pws.capacity.estimate": "Ước tính pool theo trọng số đã định cấu hình",

  "pws.capacity.currentAccount": "Tài khoản đang có hiệu lực hiện tại",

  "pws.capacity.nextRecovery": "Lần phục hồi năng lực tiếp theo",

  "pws.capacity.recoveryShare": "+{percent}% năng lực của pool",

  "pws.capacity.incomplete": "Độ phủ không đầy đủ: Đã loại trừ {excluded} tài khoản",

  "pws.capacity.uncalibratedPlan": "{count} tài khoản thuộc gói chưa được hiệu chuẩn sẽ được tính ở mức trọng số ghế tiêu chuẩn, do đó ước tính này có thể là bảo thủ",

  "pws.capacity.partial": "Độ phủ window bán phần: {count} tài khoản không báo cáo mọi limit window được hiển thị",

  "pws.capacity.windowPartial": "Bán phần",

  "pws.capacity.windowPartialA11y": "{window}: độ phủ tài khoản không đầy đủ",

  "pws.dashboard.recentlyUsed": "SỬ DỤNG GẦN ĐÂY",

  "pws.dashboard.requests": "{count} yêu cầu",

  "pws.dashboard.checkedAgo": "Đã kiểm tra {time}",

  "pws.dashboard.noQuota": "Không có dữ liệu hạn mức",

  "pws.dashboard.noUsage": "Chưa có dữ liệu sử dụng",

  "pws.dashboard.noRateLimits": "Chưa có dữ liệu giới hạn tốc độ",

  "pws.allProviders": "Tổng quan Provider",

  "pws.enabledLabel": "Đã bật",
  "pws.testConnection": "Kiểm tra kết nối",

  "pws.testing": "Đang kiểm tra…",

  "pws.connectionOk": "Kết nối OK",

  "pws.connectionFailed": "Kết nối thất bại",

  "pws.connectionNotApplicable": "Không áp dụng — provider này sử dụng danh mục model tĩnh.",

  "pws.editSettings": "Chỉnh sửa cài đặt",

  "pws.viewUsage": "Xem chi tiết mức sử dụng",

  "pws.allSystemsOk": "Tất cả các hệ thống đều hoạt động",

  "pws.apiKeyConfigured": "Đã cấu hình API key",

  "pws.addApiKey": "Thêm API key",

  "pws.loggedInAs": "Đã đăng nhập với tư cách {email}",

  "pws.notLoggedIn": "Chưa đăng nhập",

  "pws.passthrough": "Codex passthrough",

  "pws.notes": "GHI CHÚ",

  "pws.notePlaceholder": "Thêm ghi chú về provider này...",

  "pws.noteSaved": "Đã lưu ghi chú",

  "pws.authSummary": "XÁC THỰC",

  "time.justNow": "Vừa xong",

  "time.notChecked": "Chưa kiểm tra",

  "time.minutesAgo": "{n} phút trước",

  "time.hoursAgo": "{n} giờ trước",

  "time.daysAgo": "{n} ngày trước",

  "modal.noMatch": "Không khớp.",

  "modal.oauthDefaultNote": "Đăng nhập bằng tài khoản của bạn — không cần API key.",

  "modal.oauthComingSoon": "Đăng nhập OAuth cho {label} sẽ có trong bản cập nhật tới. Tạm thời hãy sử dụng API key.",

  "modal.oauthComingSoonShort": "Đăng nhập OAuth cho provider này sẽ có trong bản cập nhật tới — tạm thời hãy sử dụng API key.",

  "modal.useApiKeyInstead": "Thay vào đó hãy sử dụng API key",

  "modal.setupGuide": "Hướng dẫn thiết lập",

  "modal.setupStep1Prefix": "Truy cập",

  "modal.setupDashboardLink": "bảng điều khiển {label}",

  "modal.setupStep1Suffix": "và sao chép API key của bạn",

  "modal.setupStep2": "Dán vào trường API key bên dưới",

  "modal.setupStep3": "Nhấp vào Thêm provider — các model sẽ được tự động khám phá",

  "modal.namePlaceholder": "vd: openrouter",

  "modal.duplicateWarn": "Provider \\\"{name}\\\" đã tồn tại và sẽ bị ghi đè.",

  "modal.forwardHintPrefix": "Không cần key — proxy sẽ chuyển tiếp",

  "modal.forwardCredentials": "đăng nhập codex",

  "modal.forwardHintSuffix": "thông tin xác thực của bạn đến provider này.",

  "modal.localHint": "Không lưu trữ API key. Thao tác này sẽ thêm danh mục model công khai tĩnh của Cursor cho Codex, nhưng transport trực tiếp của Cursor và tính năng thực thi file/shell native vẫn bị vô hiệu hoá cho đến khi được kiểm toán.",

  "modal.getApiKey": "Lấy API key {label} của bạn",

  "modal.apiKey": "API key",

  "modal.apiKeyTransport": "API key header",

  "modal.apiKeyTransportNative": "x-api-key (Anthropic native)",

  "modal.apiKeyTransportBearer": "Authorization: Bearer",

  "modal.apiKeyPlaceholder": "sk-… (hoặc $ENV_VAR)",

  "modal.defaultModelPlaceholder": "vd: gpt-5.5",

 "modal.baseUrlPlaceholder": "https://...",

  "modal.baseUrlPlaceholderError": "Base URL có chứa {placeholder} chưa được giải quyết. Thay thế bằng giá trị thực tế của bạn.",

  "modal.baseUrlPlaceholderHint": "Hãy thay thế {placeholder} trong Base URL bằng Account ID thực tế của bạn trước khi thêm.",

  "modal.adding": "Đang thêm…",

  "modal.useOauthLogin": "← Sử dụng đăng nhập OAuth",

"nav.codexAuth": "Xác thực Codex",

  "nav.codexSet": "Cài đặt Codex",

  "codexSet.tab.multiauth": "Đa xác thực",

  "codexSet.tab.prompt": "Prompt",

  "codexSet.prompt.title": "Prompt layer",

  "codexSet.prompt.timing": "Áp dụng cho các phiên mới bắt đầu. Các phiên đang chạy sẽ giữ nguyên cài đặt prompt hiện tại của chúng.",

  "codexSet.prompt.staleRevision": "Cấu hình đã thay đổi ở nơi khác. Danh sách đã được tải lại.",

"codexSet.prompt.writeFailed": "Không thể lưu thay đổi.",

"codexSet.prompt.loadFailed": "Không thể tải các prompt layer.",

  "codexSet.prompt.repair": "Sửa chữa",

  "codexSet.prompt.repairFailed": "Không thể hoàn thành việc sửa chữa.",

  "codexSet.drift.journalPresent": "Một tác vụ ghi trước đó chưa hoàn thành. Quá trình phục hồi sẽ tự động chạy ở lần ghi tiếp theo.",

  "codexSet.drift.projectionStale": "Các layer đã lưu và giá trị trong config.toml không khớp nhau. Sửa chữa sẽ ghi lại giá trị từ các layer của bạn.",

  "codexSet.drift.storeMissing": "Tệp layer đã biến mất trong khi các chỉ thị vẫn còn trong config.toml. Sửa chữa sẽ giữ phần văn bản này như một layer và sẽ ghi một bản sao lưu trước.",

  "codexSet.drift.ownedMalformed": "Dòng mã được sinh ra trong config.toml đã bị định dạng lại thủ công, nên không còn an toàn để ghi đè.",

  "codexSet.custom.adoptUnsupported": "Giá trị tại {path} dòng {line} không phải là chuỗi một dòng, do đó không thể nhập. Di chuyển bằng tay để quản lý tại đây.",

  "codexSet.prompt.unreadable": "Tệp config Codex tồn tại nhưng không thể đọc được, vì vậy các thay đổi sẽ bị từ chối.",

  "codexSet.layer.permissions": "Quyền truy cập",

  "codexSet.layer.collaboration": "Chế độ cộng tác",

  "codexSet.layer.environment": "Bối cảnh môi trường",

  "codexSet.layer.apps": "Ứng dụng",

"codexSet.layer.skills": "Kỹ năng (skills)",

"codexSet.prompt.extensionsUnknown": "Các extension có thể thêm layer riêng. Codex không tiết lộ chúng, do đó không thể liệt kê ở đây.",

  "codexSet.group.transition": "Thông báo chuyển tiếp",

  "codexSet.group.transitionDesc": "Các thông báo này thông báo về một sự thay đổi thay vì mô tả trạng thái, vì vậy chúng chỉ xuất hiện khi phiên chuyển sang trạng thái realtime hoặc chuyển model.",

  "codexSet.custom.slotNote": "Các layer tuỳ chỉnh được nối thành một phần theo thứ tự này.",

"codexSet.row.alwaysOn": "Luôn bật",

  "codexSet.row.onChange": "Kích hoạt khi thay đổi",

"codexSet.row.featureGated": "Được cấu hình trong [features]",

  "codexSet.row.openFeatures": "Mở cài đặt",

  "codexSet.dialog.setValue": "{value} (mặc định {fallback})",

"codexSet.dialog.copyKey": "Sao chép khoá",

"codexSet.dialog.unknownLayer": "Bản build này không có mô tả cho layer này. Layer này đến từ một runtime Codex mới hơn so với bảng điều khiển.",

  "codexSet.custom.heading": "Layer tuỳ chỉnh",

  "codexSet.custom.add": "+ Thêm layer",

  "codexSet.custom.newTitle": "Layer mới",

  "codexSet.custom.editTitle": "Chỉnh sửa layer",

  "codexSet.custom.titleLabel": "Tiêu đề",

  "codexSet.custom.bodyLabel": "Chỉ thị",

  "codexSet.custom.bodySize": "{bytes} trên {max} byte",

  "codexSet.custom.normalized": "Tab đã trở thành bốn dấu cách và kết thúc dòng đã trở thành LF.",

  "codexSet.custom.titleRequired": "Hãy nhập tiêu đề.",

  "codexSet.custom.titleTooLong": "Tiêu đề dài {count} ký tự; giới hạn là {max}.",

  "codexSet.custom.titleMultiline": "Tiêu đề phải trên một dòng duy nhất.",

  "codexSet.custom.bodyTooLarge": "Layer này có dung lượng {bytes} byte; giới hạn là {max}.",

  "codexSet.custom.composedTooLarge": "Gộp chung, các layer được kích hoạt sẽ chiếm {bytes} byte, vượt quá giới hạn.",

  "codexSet.custom.invalidCharacter": "Một ký tự điều khiển tại vị trí {position} không thể được lưu.",

  "codexSet.custom.discardPrompt": "Huỷ bỏ các thay đổi của bạn?",

  "codexSet.custom.keepEditing": "Tiếp tục chỉnh sửa",

  "codexSet.custom.delete": "Xoá {title}",

"codexSet.custom.deleteConfirm": "Bạn có chắc chắn muốn xoá layer này? Hành động này không thể hoàn tác.",

  "codexSet.custom.layerGone": "Layer đó đã bị xoá ở nơi khác, nên trình chỉnh sửa đã đóng.",

  "codexSet.custom.deleteConfirmNamed": "Xoá “{title}”? Hành động này không thể hoàn tác.",

"codexSet.custom.moveUp": "Di chuyển {title} lên",

  "codexSet.custom.prevLayer": "Layer trước",

  "codexSet.custom.nextLayer": "Layer tiếp theo",

  "codexSet.custom.navPosition": "{position} / {total}",

  "codexSet.custom.moveDown": "Di chuyển {title} xuống",

  "codexSet.custom.limitReached": "Bạn có thể giữ lại tối đa {max} layer tuỳ chỉnh.",

  "codexSet.custom.notOwned": "developer_instructions được viết bên ngoài opencodex, vì vậy không thể chỉnh sửa nó từ đây. Hãy nhập nội dung đó để quản lý nó như một layer.",

  "codexSet.custom.adopt": "Nhập các chỉ thị hiện có",

  "codexSet.custom.adoptConfirm": "Nhập dưới dạng layer",

  "codexSet.custom.adoptRefused": "Giá trị hiện có không thể được nhập.",

  "codexSet.custom.baseReplaced": "model_instructions_file được đặt là {path}, có nghĩa là một yếu tố bên ngoài opencodex đã thay thế base prompt.",

  "codexSet.lint.identity": "Cấu hình này tự nhận một danh tính khác với danh tính do Codex thiết lập.",

  "codexSet.lint.foreignTool": "Các công cụ đến từ registry; việc chỉ đặt tên chúng ở đây không tự tạo ra công cụ.",

  "codexSet.lint.placeholder": "Không có template engine nào xử lý các chỉ thị, do đó phần này sẽ được truyền đi đúng nguyên văn.",

  "codexSet.lint.applyPatch": "apply_patch được định nghĩa bởi tool registry, không phải bởi các chỉ thị.",

  "codexSet.lint.approvalVocab": "Codex tự chèn thêm từ vựng phê duyệt riêng; điều này có thể mâu thuẫn với nó.",

  "codexSet.lint.environment": "Các sự kiện thực tế của môi trường được sinh ra sau đó và có thể gây mâu thuẫn với cấu hình này.",

"codexSet.lint.size": "Layer này vượt quá 8 KB. Nó vẫn có thể được lưu lại, nhưng sẽ tốn token trong mỗi yêu cầu.",

  "codexSet.preset.blank": "Layer trống",

  "codexSet.preset.concise.name": "Phản hồi súc tích",

  "codexSet.preset.concise.description": "Câu trả lời ngắn gọn, không có phần mở đầu, giảm thiểu định dạng.",

  "codexSet.preset.concise.provenance": "Được điều chỉnh từ chỉ thị hướng đến sự ngắn gọn của Claude Code. Chúng tôi tự diễn đạt lại, không phải sao chép.",

  "codexSet.preset.planFirst.name": "Lập kế hoạch trước khi chỉnh sửa",

  "codexSet.preset.planFirst.description": "Trình bày kế hoạch trước, sau đó mới thực hiện thay đổi.",

  "codexSet.preset.planFirst.provenance": "Được điều chỉnh từ phong thái lập kế hoạch của Claude Code. Chúng tôi tự diễn đạt lại, không phải sao chép.",

  "codexSet.preset.explainWhy.name": "Giải thích lý do",

  "codexSet.preset.explainWhy.description": "Cho biết tại sao lại thực hiện điều đó, thay vì chỉ mô tả những gì bạn đã làm.",

  "codexSet.preset.explainWhy.provenance": "Được điều chỉnh từ phong cách xác nhận của Grok Build. Chúng tôi tự diễn đạt lại, không phải sao chép.",

  "codexSet.preset.testFirst.name": "Viết test trước tiên",

  "codexSet.preset.testFirst.description": "Viết fail test trước khi tiến hành sửa lỗi.",

  "codexSet.preset.testFirst.provenance": "Được điều chỉnh từ quy trình thực hành thông thường của agent. Chúng tôi tự diễn đạt lại, không phải sao chép.",

  "codexSet.preset.korean.name": "Phản hồi bằng tiếng Hàn",

  "codexSet.preset.korean.description": "Luôn trả lời bằng tiếng Hàn cho dù yêu cầu sử dụng bất kỳ ngôn ngữ nào.",

  "codexSet.preset.korean.provenance": "Được viết riêng cho opencodex dựa trên một tính năng chủ lực do người dùng yêu cầu. Chúng tôi tự diễn đạt lại, không phải sao chép.",

  "codexSet.dialog.class": "Loại",

  "codexSet.dialog.key": "Khoá cấu hình",

  "codexSet.dialog.fileValue": "Giá trị trong tệp này",

  "codexSet.dialog.absentDefault": "chưa thiết lập (mặc định là {value})",

"codexSet.dialog.noRenderedText": "Codex không để lộ văn bản đã tổng hợp của một layer tích hợp, do đó hộp thoại này chỉ mô tả về layer đó và đưa ra tên khoá tương ứng thay vì hiển thị toàn bộ nội dung của nó.",

  "codexSet.dialog.sourceText": "Văn bản được gửi tới model",

  "codexSet.dialog.sourceBytes": "{bytes} byte",

"codexSet.dialog.notRendered": "Layer này không gửi gì ở lượt mà chúng tôi đang đọc. Các phần nội dung chỉ được gửi lại khi chúng có sự thay đổi, vì vậy một layer không thay đổi sẽ không hiển thị trong một mẫu kiểm tra (sample).",

  "codexSet.dialog.emptySource": "Tệp tại {path} tồn tại nhưng không có dữ liệu, vì vậy layer này không gửi đi nội dung nào cả.",

  "codexSet.dialog.notExposed": "Base prompt di chuyển bên ngoài danh sách tin nhắn mà Codex có thể in ra, vì vậy không thể hiển thị ở đây. Tuy nhiên có thể thay thế nó thông qua model_instructions_file.",

  "codexSet.dialog.textUnavailable": "Không thể đọc prompt Codex trên máy này, do đó văn bản không khả dụng.",

  "codexSet.class.base": "Base instructions",

  "codexSet.class.config-toggle": "Có thể chuyển đổi tại đây",

  "codexSet.class.feature-gated": "Tính năng bị giới hạn",

  "codexSet.class.runtime-conditional": "Phụ thuộc vào runtime",

  "codexSet.class.extension-unknown": "Layer mở rộng",

  "codexSet.layer.base-instructions": "Base instructions",

  "codexSet.layer.model-switch": "Thông báo chuyển đổi model",

  "codexSet.layer.personality": "Tính cách",

  "codexSet.layer.context-window-guidance": "Hướng dẫn context window",

  "codexSet.layer.realtime": "Realtime",

  "codexSet.layer.agents-md": "AGENTS.md",

  "codexSet.layer.environments-instructions": "Môi trường",

  "codexSet.layer.plugins": "Plugins",

  "codexSet.layer.tools": "Công cụ",

  "codexSet.layer.multi-agent-mode": "Chế độ multi-agent",

  "codexSet.layer.git-attribution": "Attribution commit",

  "codexSet.about.base-instructions": "Base instructions của riêng Codex. Chúng đi kèm với chính yêu cầu và không thể bị tắt.",

  "codexSet.about.model-switch": "Được thêm vào khi phiên trò chuyện thay đổi model giữa cuộc hội thoại.",

  "codexSet.about.personality": "Hướng dẫn về giọng điệu và phong cách, được điều khiển bởi một feature flag.",

  "codexSet.about.context-window-guidance": "Lời khuyên về ngân sách context còn lại, được điều khiển bởi một feature flag.",

  "codexSet.about.realtime": "Được thêm vào cho các phiên realtime.",

  "codexSet.about.agents-md": "Tệp AGENTS.md cho dự án của bạn. Trang này chỉ báo cáo layer; nó không bao giờ chỉnh sửa tài liệu dự án của bạn.",

  "codexSet.about.permissions": "Giải thích về sandbox và các cài đặt phê duyệt đang có hiệu lực.",

  "codexSet.about.collaboration": "Giải thích chế độ cộng tác đang hoạt động.",

  "codexSet.about.environment": "Thư mục làm việc, nền tảng, và các sự kiện môi trường thực tế khác.",

  "codexSet.about.environments-instructions": "Hướng dẫn cho môi trường thực thi trì hoãn, được điều khiển bởi một feature flag.",

  "codexSet.about.apps": "Cách sử dụng các ứng dụng đã kết nối.",

  "codexSet.about.plugins": "Được thêm vào khi một plugin được chọn hoặc khi bất kỳ plugin nào quảng cáo về năng lực của mình.",

  "codexSet.about.tools": "Mô tả công cụ trì hoãn, được điều khiển bởi một feature flag.",

  "codexSet.about.skills": "Danh sách các kỹ năng (skills) khả dụng.",

  "codexSet.about.multi-agent-mode": "Chỉ thị cho subagent, được điều khiển bởi một feature flag.",

  "codexSet.about.git-attribution": "Yêu cầu model thêm trailer Co-authored-by: Codex vào các commit mà nó viết, và dòng Generated with Codex. vào các pull request mà nó mở. Codex phân giải điều này từ tài khoản của bạn, vì vậy không có cài đặt nào cho nó ở đây hay dưới phần [features]. Khi tài khoản của bạn tắt tính năng này, Codex sẽ gửi hướng dẫn ngược lại thay vì không gửi gì.",

  "codexSet.condition.model-switch": "Chỉ được phát ra sau khi có sự thay đổi model giữa phiên làm việc.",

  "codexSet.condition.realtime": "Chỉ được phát ra trong phiên realtime.",

  "codexSet.condition.agents-md": "Được phát ra khi tìm thấy một tài liệu dự án cho thư mục làm việc.",

  "codexSet.condition.plugins": "Được phát ra khi một plugin được chọn hoặc khi có bất kỳ plugin nào quảng cáo về năng lực của mình.",

  "codexSet.condition.git-attribution": "Được cấu hình bởi chính sách attribution của tài khoản của bạn.",

  "codexSet.base.title": "Base prompt",

  "codexSet.base.prev": "Tuỳ chọn trước đó",

  "codexSet.base.next": "Tuỳ chọn tiếp theo",

  "codexSet.base.position": "{position} / {total}",

  "codexSet.base.swipeHint": "Vuốt sang một bên, sử dụng các phím mũi tên hoặc nhấn vào các mũi tên để di chuyển qua lại giữa các tuỳ chọn. Chỉ áp dụng cho các phiên mới bắt đầu.",

  "codexSet.base.defaultTitle": "Base prompt của riêng Codex",

  "codexSet.base.defaultBody": "Mặc định không được lưu ở đây, vì vậy không có gì để chỉnh sửa hoặc xoá: việc chọn nó đơn giản là sẽ xoá model_instructions_file khỏi cấu hình của bạn, và Codex sử dụng prompt đi kèm với nó.",

  "codexSet.base.variantTitle": "Tên",
  "codexSet.base.variantBody": "Prompt",

  "codexSet.base.replacesWarning": "Điều này SẼ THAY THẾ base prompt của chính Codex chứ không bổ sung thêm. Một prompt ngắn ở đây đồng nghĩa với một model có những chỉ thị ngắn.",

  "codexSet.base.use": "Sử dụng cái này",

  "codexSet.base.inUse": "Đang sử dụng",

  "codexSet.base.externalBlocked": "model_instructions_file đã được trỏ tới {path}, tệp mà opencodex không hề viết. Hãy tự xoá tệp đó đi trước khi chọn một tuỳ chọn tại đây.",

  "nav.api": "API",

  "nav.integrations": "Tích hợp",
  "nav.openMenu": "Mở menu",

  "nav.closeMenu": "Đóng menu",

  "nav.goHome": "Đi tới bảng điều khiển",

  "pws.refreshAllQuotas": "Làm mới tất cả hạn mức",

  "pws.quotaRefreshDone": "Đã kiểm tra hạn mức xong",

  "integrations.subtitle": "Kết nối các client với opencodex, quản lý thông tin xác thực, và khôi phục cấu hình client.",

  "integrations.tabsLabel": "Các bề mặt tích hợp",

  "integrations.tab.overview": "Tổng quan",
  "integrations.tab.keys": "API Keys",

  "integrations.tab.codex": "Codex",

  "integrations.tab.claude": "Claude",

  "integrations.tab.grok": "Grok Build",

  "integrations.tab.cursor": "Cursor",

  "integrations.tab.opencode": "OpenCode",

  "integrations.tab.pi": "Pi",

  "integrations.tab.omp": "OMP",

  "integrations.tab.hermes": "Hermes",

  "integrations.tab.openclaw": "OpenClaw",

  "integrations.tab.kimi": "Kimi Code",

  "integrations.tab.gajae": "Gajae Code",

  "integrations.tab.dsh": "DSH",

  "integrations.tab.mcode": "MiniMax Code",

  "integrations.tab.zcode": "ZCode",

  "integrations.tab.prime": "Prime Agent",

  "integrations.tab.aside": "Aside",

  "integrations.tab.raycast": "Raycast",

  "integrations.aside.profilesTitle": "Cấu hình Aside",

  "integrations.aside.profilesHint": "Chọn profile nào sẽ nhận các model được chọn. Profile đang hoạt động của Aside sẽ được giữ nguyên.",

  "integrations.aside.all": "Đồng bộ tất cả profile",

  "integrations.aside.syncNow": "Đồng bộ ngay",

  "integrations.aside.applied": "{count}/{total} profile đã được áp dụng",

  "integrations.aside.current": "Profile hiện tại",

  "integrations.aside.profile": "Profile {id}",

  "integrations.aside.toggle": "Đồng bộ {name}",

  "integrations.aside.details": "Quản lý {name}",

  "integrations.aside.back": "Tất cả profile Aside",

  "integrations.aside.empty": "Mở Aside và tạo một profile để kết nối nó.",

  "integrations.aside.partial": "Một số profile cần chú ý. Các lựa chọn đồng bộ của bạn đã được lưu; hãy kiểm tra trạng thái của từng profile.",

  "integrations.aside.pending": "Lựa chọn đồng bộ đã được lưu; đang chờ cập nhật file.",

  "integrations.aside.retry": "Thử lại {name}",

  "integrations.aside.loadError": "Không thể tải các profile Aside. Thử lại để kiểm tra trạng thái của chúng.",

  "integrations.codex.title": "Codex CLI",

  "integrations.codex.body": "Việc kết nối Codex do proxy service quản lý. Khởi động opencodex sẽ áp dụng nó; dừng service sẽ khôi phục lại định tuyến nguyên bản.",

  "integrations.codex.openService": "Mở cài đặt service",

  "integrations.state.notInstalled": "Chưa cài đặt",

  "integrations.state.unknown": "Đang kiểm tra…",

  "integrations.detail.codexRouted": "Các request của Codex đi qua proxy này",

  "integrations.detail.codexAbsent": "Codex chưa được định tuyến qua proxy này",

  "integrations.detail.keyCount": "{count} key đã được cấp",

  "integrations.detail.keyNone": "Chưa có key nào được cấp",

  "integrations.detail.keyChecking": "Đang kiểm tra…",

  "integrations.detail.keyUnavailable": "Không có thông tin trạng thái key",

  "integrations.detail.claudeOff": "Kết nối đang tắt",

  "integrations.detail.desktopCurrent": "Desktop đang chạy profile này",

  "integrations.detail.desktopStale": "File profile đã bị thay đổi sau khi được áp dụng",

  "integrations.detail.desktopNotServed": "Profile có tồn tại, nhưng Desktop đang sử dụng một profile khác",

  "integrations.detail.desktopAbsent": "Chưa có profile nào được áp dụng",

  "integrations.detail.desktopDesiredOff": "Tích hợp Claude Desktop đang tắt",

  "integrations.detail.desktopDesiredOffCleanupPending": "Claude Desktop vẫn đang sử dụng gateway; đang chờ dọn dẹp",

  "integrations.detail.desktopDesiredOnNotApplied": "Tích hợp đang bật, nhưng Desktop không sử dụng profile gateway",

  "integrations.detail.desktopSelectedElsewhere": "Desktop đang sử dụng một profile khác",

  "integrations.detail.desktopProfileDrift": "Profile Desktop được chọn đã bị thay đổi",

  "integrations.detail.desktopObservedUnsafe": "Không thể thay đổi profile Desktop được chọn một cách an toàn",

  "integrations.detail.desktopNotInstalled": "Thư viện cấu hình Claude Desktop chưa được cài đặt",

  "integrations.detail.grokModels": "{count} model đã được kết nối",

  "integrations.detail.grokAbsent": "Không có block opencodex nào trong config",

  "integrations.detail.cursorSeen": "Cursor đã gọi proxy này gần đây",

  "integrations.detail.cursorNeverSeen": "Đã cài đặt Private Inference; chưa thấy request nào",

  "integrations.detail.cursorAbsent": "Không tìm thấy Cursor Private Inference",

  "integrations.cursor.title": "Cursor",

  "integrations.cursor.intro": "Cursor Private Inference chạy agent của nó cục bộ và giao tiếp với opencodex trên loopback. Cursor bản thường không thể làm điều này: backend của nó gọi endpoint tùy chỉnh và cần một URL HTTPS công khai. Trang này không bao giờ ghi dữ liệu vào Cursor; bạn hãy tự dán các giá trị bên dưới vào Cursor.",

  "integrations.cursor.loading": "Đang đọc trạng thái Cursor…",

  "integrations.cursor.unavailable": "Không thể đọc trạng thái Cursor từ proxy.",

  "integrations.cursor.detection": "Các bản cài đặt được phát hiện",

  "integrations.cursor.privateInference": "Cursor Private Inference",

  "integrations.cursor.regular": "Cursor (bản thường)",

  "integrations.cursor.detected": "Đã phát hiện",

  "integrations.cursor.notFound": "Không tìm thấy",

  "integrations.cursor.regularOnly": "Chỉ tìm thấy Cursor bản thường. Nó định tuyến các custom endpoint qua server của Cursor, vì vậy proxy loopback không thể tiếp cận nếu không có public tunnel. Hãy xem hướng dẫn về bản Private Inference.",

  "integrations.cursor.nothingFound": "Không tìm thấy bản cài đặt Cursor nào ở các vị trí thông thường. Nếu nó được cài đặt ở nơi khác, các giá trị bên dưới vẫn được áp dụng.",

  "integrations.cursor.gateway": "Giá trị Gateway",

  "integrations.cursor.gatewayHint": "Trong Cursor Private Inference, mở Settings > Models > Gateway, dán hai giá trị này, sau đó nhấn Refresh model list.",

  "integrations.cursor.baseUrl": "Base URL",

  "integrations.cursor.apiKey": "API Key",

  "integrations.cursor.apiKeyCredential": "Một trong các API key opencodex của bạn (liên kết này yêu cầu credential)",

  "integrations.cursor.copy": "Sao chép",
  "integrations.cursor.copied": "Đã sao chép",
  "integrations.cursor.connection": "Kết nối",

  "integrations.cursor.seen": "Request cuối cùng từ Cursor: {time} ({ua})",

  "integrations.cursor.neverSeen": "Chưa có request nào từ Cursor kể từ khi khởi động proxy. Sau khi lưu gateway, hãy nhấn Refresh model list trong Cursor.",

  "integrations.cursor.models": "Những gì Cursor sẽ hiển thị",

  "integrations.cursor.modelsHint": "Cursor lấy danh sách Reasoning từ bảng model của riêng nó, vì vậy opencodex chỉ có thể dự đoán. Context liệt kê mặc định và cửa sổ opt-in (Max Mode của Cursor).",

  "integrations.cursor.ladderFromBundle": "Danh sách Reasoning đọc từ gói Cursor Private Inference {version} đã cài đặt. Cursor quyết định chúng; opencodex chỉ báo cáo bảng của nó.",

  "integrations.cursor.ladderFromStatic": "Danh sách Reasoning là một bản sao tĩnh của Cursor 3.18.25 (không tìm thấy gói Private Inference nào có thể đọc được). Context liệt kê mặc định và cửa sổ opt-in.",

  "integrations.cursor.unknownVersion": "không rõ phiên bản",

  "integrations.cursor.noControl": "—",
  "integrations.cursor.singleWindow": "cửa sổ đơn",

  "integrations.cursor.noControlTitle": "ID này không có trong bảng effort tích hợp của Cursor, nên Cursor sẽ không hiển thị nút điều khiển Reasoning.",

  "integrations.cursor.effortRowsOne": "1 dòng effort được công bố",

  "integrations.cursor.effortRowsMany": "{n} dòng effort được công bố",

  "integrations.cursor.effortRowsOff": "không có dòng effort",

  "integrations.cursor.tableLessHint": "Các dòng được đánh dấu — sẽ không có nút điều khiển Reasoning trong Cursor. Bật cursorEffortRows để xuất ra một mục lựa chọn cho mỗi effort (id--effort), hoặc đặt modelDefaultReasoningEfforts trên provider để dùng mặc định cố định.",

  "integrations.cursor.colModel": "Model",

  "integrations.cursor.colReasoning": "Reasoning",

  "integrations.cursor.colContext": "Context",

  "integrations.cursor.guide": "Mở hướng dẫn Cursor Private Inference",

  "integrations.dialog.codex.title": "Vô hiệu hóa tích hợp Codex?",

  "integrations.dialog.codex.changes": "opencodex sẽ gỡ bỏ routing của nó khỏi {path}, gỡ bỏ profile nó tạo ra, khôi phục lại model catalog mặc định, và đổi thẻ các luồng có thể tiếp tục về native Codex.",

  "integrations.dialog.codex.breakage": "Codex thuần sẽ kết nối trực tiếp đến OpenAI, và các model được định tuyến từ provider khác sẽ biến mất khỏi Codex. Proxy và /v1/responses vẫn tiếp tục chạy cho các client khác.",

  "integrations.dialog.codex.undo": "Bật lại tính năng này sẽ xây dựng lại catalog được định tuyến từ các model hiện có và chèn Codex vào một lần nữa. Lịch sử cũ có thể dùng lại được cho hướng tương ứng, nhưng các file không được khôi phục chính xác từng byte.",

  "integrations.dialog.codex.sideEffect": "Nếu bạn chọn một routed root model sau khi opencodex chèn cấu hình, việc vô hiệu hóa sẽ gỡ bỏ lựa chọn model đó và bật lại tích hợp sẽ không thể phục hồi nó; bạn hãy chọn lại model. Nếu một model_provider ngoài quản lý Codex, opencodex chỉ gỡ bỏ journal cũ của nó và giữ nguyên cấu hình, catalog và lịch sử.",

  "integrations.dialog.codex.confirm": "Vô hiệu hóa",

  "integrations.dialog.grok.title": "Vô hiệu hóa tích hợp Grok Build?",

  "integrations.dialog.grok.changes": "Chỉ block được đánh dấu bởi opencodex sẽ bị gỡ bỏ khỏi {path}. Nội dung được ghi bên ngoài block sẽ giữ nguyên.",

  "integrations.dialog.grok.breakage": "Việc vô hiệu hóa sẽ gỡ bỏ các bí danh model opencodex khỏi Grok Build. Các model được dùng với tài khoản xAI của bạn vẫn hoạt động.",

  "integrations.dialog.grok.undo": "Nếu opencodex đang chạy trên địa chỉ loopback, việc bật lại tính năng này sẽ ghi một block mới từ các model hiện có.",

  "integrations.dialog.grok.confirm": "Vô hiệu hóa",

  "integrations.dialog.desktop.title": "Vô hiệu hóa tích hợp Claude Desktop?",

  "integrations.dialog.desktop.changes": "Nếu {path} chứa một profile gateway do opencodex quản lý, Desktop sẽ chuyển về một profile tiêu chuẩn không cần credential, sau đó xóa profile cũ và bản sao lưu.",

  "integrations.dialog.desktop.breakage": "Claude Desktop sẽ trở lại dùng Claude tiêu chuẩn thay vì các model định tuyến qua opencodex.",

  "integrations.dialog.desktop.undo": "Bật lại tính năng này sẽ tạo lại profile opencodex từ các thiết lập model đã lưu của bạn.",

  "integrations.dialog.desktop.restart": "Claude Desktop chỉ đọc cấu hình này khi khởi động. Hãy thoát hoàn toàn và mở lại để thay đổi có hiệu lực.",

  "integrations.dialog.desktop.confirm": "Vô hiệu hóa",

  "integrations.native.msg.nonLoopbackRemoved": "Grok Build chỉ có thể tự động đăng ký khi opencodex đang chạy trên một địa chỉ loopback. Block trước đó trỏ tới loopback đã bị xóa.",

  "integrations.native.msg.nonLoopbackRemovedNoop": "Grok Build chỉ có thể tự động đăng ký khi opencodex đang chạy trên một địa chỉ loopback. Không có block trước đó nào để xóa.",

  "integrations.native.msg.nonLoopbackSuperseded": "Grok Build chỉ có thể tự động đăng ký khi opencodex đang chạy trên một địa chỉ loopback. Một tiến trình khác đã ghi một block mới trong khi chờ, do đó block hiện tại trong file không phải do request này tạo ra.",

  "integrations.native.error.orphanedMarker": "{path} có một điểm bắt đầu của opencodex nhưng không có điểm kết thúc. File không được thay đổi vì opencodex không thể xác định điểm cuối của block.",

  "integrations.native.error.homeMismatch": "Thư mục cài đặt service không khớp với thư mục hiện tại, vì vậy file không được thay đổi.",

  "integrations.native.error.notInstalled": "Grok Build chưa được cài đặt, nên không có gì để thay đổi.",

  "integrations.native.error.configBusy": "Cấu hình đang được lưu ở nơi khác và không thể thay đổi. Hãy thử lại sau ít phút.",

  "integrations.native.error.desktopUnsafeMetadata": "Metadata của Claude Desktop tại {path} không thể được đọc một cách an toàn, vì vậy thư viện của nó không được thay đổi.",

  "integrations.native.error.desktopCleanupIncomplete": "Claude Desktop đang trỏ tới chế độ tiêu chuẩn, nhưng các file credential opencodex cũ vẫn còn tại: {paths}.",

  "integrations.native.msg.desktopDisabled": "Tích hợp Claude Desktop đã bị vô hiệu hóa.",

  "integrations.native.msg.desktopEnabled": "Tích hợp Claude Desktop đã được kích hoạt.",

  "integrations.state.absent": "Chưa được áp dụng",

  "integrations.state.current": "Đã được áp dụng",

  "integrations.state.stale": "Cần cập nhật",

  "integrations.state.conflict": "Xung đột",

  "integrations.state.unsafe": "Không thể xác minh",

  "integrations.summary.detected": "Các client được phát hiện",

  "integrations.summary.applied": "Các client đã cấu hình",

  "integrations.summary.stale": "Cần cập nhật",

  "integrations.summary.lastChange": "Thay đổi cuối cùng",

  "integrations.summary.disableAll": "Vô hiệu hóa tất cả…",

  "integrations.onboarding": "Việc áp dụng sẽ ghi một provider block opencodex sau khi lưu một bản sao lưu. Việc vô hiệu hóa chỉ xóa block đó, và bản sao lưu đã giữ lại có thể được dùng để khôi phục.",

  "integrations.empty.title": "Không tìm thấy client nào đã được cài đặt",

  "integrations.empty.body": "Hãy cài đặt một client được hỗ trợ, sau đó quay lại đây để áp dụng opencodex.",

  "integrations.action.apply": "Áp dụng",
  "integrations.action.disable": "Vô hiệu hóa",

  "integrations.action.refresh": "Cập nhật",
  "integrations.action.settings": "Cài đặt",
  "integrations.action.manageKeys": "Quản lý key",

  "integrations.action.restore": "Khôi phục…",

  "integrations.action.undo": "Hoàn tác",

  "integrations.action.restorePoint": "Khôi phục điểm này…",

  "integrations.action.snapshotExpired": "Bản sao lưu đã hết hạn",

  "integrations.rollback.title": "Trung tâm hoàn tác",

  "integrations.rollback.empty": "Chưa có lịch sử áp dụng",

  "integrations.rollback.emptyBody": "Mỗi lần ghi thành công sẽ lưu một bản sao lưu trước khi ghi.",

  "integrations.catalog.title": "Clients",

  "integrations.rollback.older": "Các thao tác cũ hơn",

  "integrations.rollback.showMore": "Hiển thị thêm {n} mục",

  "integrations.rollback.failed": "Không thể tải lịch sử hoàn tác.",

  "integrations.rollback.delete": "Xóa",
  "integrations.rollback.deleteAria": "Xóa mục hoàn tác từ {at}",

  "integrations.rollback.deleteNewest": "Mục gần đây nhất của client này được giữ lại để bạn vẫn có thể hoàn tác nó.",

  "integrations.rollback.deleteGone": "Mục này đã bị xóa. Danh sách sẽ tự động làm mới.",

  "integrations.dialog.deleteEntry.title": "Xóa mục hoàn tác này?",

  "integrations.dialog.deleteEntry.changes": "Mục này sẽ biến mất khỏi danh sách hoàn tác, và bất kỳ bản sao lưu nào nó giữ cho {path} sẽ bị xóa khỏi đĩa.",

  "integrations.dialog.deleteEntry.breakage": "Bạn sẽ không thể khôi phục file về thời điểm này nữa. Các mục mới hơn và bản thân file sẽ không bị ảnh hưởng.",

  "integrations.dialog.deleteEntry.undo": "Thao tác này không thể hoàn tác. Mục gần đây nhất của mỗi client luôn được giữ lại và không thể xóa.",

  "integrations.dialog.deleteEntry.confirm": "Xóa mục",

  "integrations.restore.title": "Khôi phục bản sao lưu này?",

  "integrations.restore.body": "File hiện tại sẽ được sao lưu trước, sau đó bản sao lưu đã chọn sẽ thay thế nó.",

  "integrations.restore.driftTitle": "Đã phát hiện các thay đổi mới hơn",

  "integrations.restore.driftBody": "Các thay đổi được thực hiện sau bản sao lưu này sẽ được sao lưu lại, sau đó file sẽ bị thay thế.",

  "integrations.restore.confirm": "Khôi phục",

  "integrations.restore.confirmDrift": "Sao lưu các thay đổi mới và khôi phục",

  "integrations.restore.pending": "Đang khôi phục…",

  "integrations.restore.manual": "Khôi phục tự động thất bại: {reason}. Hãy khôi phục thủ công từ {path}.",

  "integrations.error.load": "Không thể tải trạng thái tích hợp.",

  "integrations.error.stale": "Lần làm mới cuối cùng thất bại. Các giá trị bên dưới có thể đã cũ.",

  "integrations.error.busy": "Một thay đổi khác cho client này vẫn đang chạy. Hãy thử lại sau ít phút.",

  "integrations.error.conflict": "Cấu hình đã thay đổi sau khi opencodex ghi nó. Không có nội dung nào bị xóa.",

  "integrations.error.unsafe": "Cấu hình không thể thay đổi một cách an toàn.",

  "integrations.error.generic": "Việc thay đổi tích hợp thất bại. Trạng thái trước đó của bạn vẫn được giữ nguyên.",

  "integrations.error.nonLoopback": "{client} chỉ có thể kết nối với proxy trên localhost — cấu hình của nó không có chỗ để đặt header admission mà một kết nối từ xa yêu cầu, vì vậy việc viết thủ công cũng không giúp ích. Thay vào đó, hãy cấp quyền truy cập loopback cho nó qua một tunnel hoặc local forwarder.",

  "integrations.status.installed": "Đã cài đặt",

  "integrations.status.notInstalled": "Chưa cài đặt",

  "integrations.status.appliedAt": "Đã áp dụng",

  "integrations.status.backup": "Sao lưu",

  "integrations.status.lastRestore": "Lần khôi phục cuối",

  "integrations.status.unknown": "Không xác định",
  "integrations.bulk.title": "Vô hiệu hóa các tích hợp client đã áp dụng?",

  "integrations.bulk.body": "Chỉ block thuộc về opencodex mới bị xóa. Một bản sao lưu trước khi ghi sẽ được giữ lại cho từng client.",

  "integrations.bulk.partial": "Một số client không thể vô hiệu hóa: {clients}",

  "integrations.bulk.success": "Các tích hợp client đã áp dụng đã bị vô hiệu hóa.",

  "integrations.retention.degraded": "Việc dọn dẹp bản sao lưu bị chậm trễ; các bản sao lưu cũ hơn có thể vẫn còn trên đĩa.",

  "integrations.error.residual": "File có thể đang ở trạng thái trung gian: {message} Hãy khôi phục nó từ {path}.",

  "integrations.error.residualNoSnapshot": "{message} Quá trình khôi phục tự động chưa hoàn tất. Hãy kiểm tra cấu hình client trước khi thử lại.",

  "integrations.error.recover": "{message} Một bản sao lưu nằm tại {path}.",

  "integrations.kind.apply": "Đã áp dụng",

  "integrations.kind.disable": "Đã tắt",
  "integrations.kind.refresh": "Đã cập nhật",

  "integrations.kind.restore": "Đã khôi phục",

  "integrations.kind.overwrite": "Đã ghi đè",

  "integrations.dialog.overwrite.title": "Thay thế block trong config này?",

  "integrations.dialog.overwrite.changesUnowned": "Một block không do chúng ta ghi đã chiếm lấy các thiết lập mà opencodex cần trong {path}. Việc áp dụng sẽ thay thế nó bằng block mà opencodex sẽ ghi.",

  "integrations.dialog.overwrite.changesForeign": "Thay đổi của bạn bên trong block opencodex ở {path} sẽ bị loại bỏ và thay thế bằng block mà opencodex sẽ ghi.",

  "integrations.dialog.overwrite.breakage": "Bất cứ thứ gì mà block kia cấu hình sẽ ngừng hoạt động. Nội dung ở những chỗ khác trong file được giữ nguyên.",

  "integrations.dialog.overwrite.undo": "Một bản sao lưu sẽ được lưu trước tiên, do đó thao tác này sẽ xuất hiện trong danh sách hoàn tác bên dưới và có thể được khôi phục.",

  "integrations.dialog.overwrite.confirm": "Thay thế",

  "integrations.action.overwrite": "Thay thế",

  "integrations.semantics.opencode": "Chỉ khởi chạy trực tiếp trên đĩa; việc inject môi trường ocx opencode sẽ được ưu tiên.",

  "integrations.semantics.pi": "Áp dụng cho các session mới.",

  "integrations.semantics.omp": "Khởi động lại OMP để tải catalog.",

  "integrations.semantics.hermes": "Áp dụng cho các session mới.",

  "integrations.semantics.openclaw": "Áp dụng ngay cho gateway đang chạy.",

  "integrations.semantics.kimi": "Khởi động lại hoặc chạy /reload để áp dụng (v2 theo dõi file).",

  "integrations.semantics.gajae": "Áp dụng cho session mới hoặc khi mở /model.",

  "integrations.semantics.dsh": "OpenCodex chỉ quản lý llm-pi-ai.providers.opencodex trong $DSH_HOME/settings.yaml. DSH sẽ hot reload provider này; model mặc định của bạn và deepseek-official không thay đổi. Hiện chỉ hỗ trợ loopback; không ghi credential thật nào.",

  "integrations.semantics.mcode": "Chỉ quản lý custom_provider.opencodex. Model mặc định của bạn và đăng nhập MiniMax không thay đổi.",

  "integrations.semantics.zcode": "Chỉ quản lý provider.opencodex trong ~/.zcode/v2/config.json. Đăng nhập Z.ai của bạn và các provider khác không thay đổi. Khởi động lại ZCode sau khi thay đổi.",

  "integrations.semantics.prime": "Chỉ quản lý providers.opencodex trong models.json của Prime Agent — ~/.prime/agent trừ khi PRIME_AGENT_CODING_AGENT_DIR điều hướng nó. Các provider khác và ngoại lệ model của bạn không thay đổi. Áp dụng cho các session mới.",

  "integrations.semantics.aside": "Chỉ quản lý providers.opencodex trong ~/.aside/u/<id>/models.json của profile này. Các provider khác của bạn không thay đổi. Hãy thoát hoàn toàn và mở lại Aside sau khi áp dụng.",

  "integrations.semantics.raycast": "Thêm một provider OpenCodex vào providers.yaml của Raycast để mọi model được định tuyến xuất hiện trong bộ chọn model AI của Raycast. Yêu cầu Raycast Pro.",

  "integrations.raycast.proRequired": "Custom Providers là một tính năng của Raycast Pro. File sẽ được ghi, nhưng Raycast sẽ bỏ qua nó cho đến khi đăng ký Pro được kích hoạt.",

  "integrations.raycast.planUnknown": "Không thể xác định xem Raycast Pro có đang hoạt động hay không; Custom Providers yêu cầu Raycast Pro.",

  "integrations.raycast.revealConfig": "Mở Raycast → Settings → AI và nhấp vào Reveal Providers Config một lần để thư mục providers được tạo.",

  "codexAuth.mainAccount": "Tài khoản chính",

  "codexAuth.logLabel": "Nhãn log",

  "codexAuth.codexApp": "Codex App",

  "codexAuth.moreActions": "Hiển thị thêm hành động",

  "codexAuth.copyId": "Sao chép Account ID",

  "codexAuth.appLogin": "Đăng nhập App",

  "codexAuth.accountPool": "Pool tài khoản",

  "codexAuth.accountModeTitle": "Chế độ tài khoản OpenAI",

  "codexAuth.accountModePool": "Chế độ Pool",

  "codexAuth.accountModePoolDesc": "Tài khoản đăng nhập chính và các tài khoản đủ điều kiện được thêm vào sẽ luân phiên ở đây.",

  "codexAuth.accountModeDirect": "Chế độ Direct",

  "codexAuth.accountModeDirectDesc": "Các request chỉ sử dụng tài khoản đăng nhập chính; các tài khoản được thêm vào vẫn được lưu để dùng cho chế độ Pool.",

  "codexAuth.openaiMissing": "Provider OpenAI mặc định chưa được cấu hình.",

  "codexAuth.openaiDisabled": "Provider OpenAI mặc định đang bị vô hiệu hóa.",

  "codexAuth.openaiUnavailableDesc": "Các tài khoản OpenAI của bạn vẫn khả dụng. Hãy bật provider để định tuyến các request của Codex.",

  "codexAuth.enableOpenai": "Bật OpenAI",

  "codexAuth.enablingOpenai": "Đang bật...",

  "codexAuth.enableOpenaiFailed": "Không thể bật provider OpenAI.",

  "codexAuth.openaiPresetLoadFailed": "Không thể tải preset của provider OpenAI.",

  "codexAuth.openaiPresetUnavailable": "Preset của provider OpenAI không khả dụng.",

  "codexAuth.openProviders": "Mở Providers",

  "codexAuth.add": "Thêm",
  "codexAuth.sparkQuota": "Quota Codex Spark",

  "codexAuth.sparkQuotaHint": "Hiển thị cửa sổ GPT-5.3-Codex-Spark hàng tuần trên các thẻ tài khoản. Ẩn mặc định vì nó chỉ áp dụng cho một model.",

  "codexAuth.sparkQuotaShown": "Quota Codex Spark đang hiện",

  "codexAuth.sparkQuotaHidden": "Quota Codex Spark đang ẩn",

  "codexAuth.sparkQuotaFailed": "Không thể thay đổi cài đặt quota Codex Spark",

  "codexAuth.refreshQuota": "Làm mới quota",

  "codexAuth.ultraFastTitle": "Dịch vụ cấp độ Ultra Fast",

  "codexAuth.mainHardLockTitle": "Khóa tài khoản chính ở mức 99%",

  "codexAuth.mainHardLockDesc": "Sử dụng mức 5h nếu có, nếu không thì dùng hàng tuần (hoặc hàng tháng đối với tài khoản chỉ có hàng tháng). Một kết quả đọc 0% mới sẽ tự động mở khóa; bảo vệ vẫn tiếp tục bật.",

  "codexAuth.mainHardLockConfirmTitle": "Bật khóa 99% tài khoản chính?",

  "codexAuth.mainHardLockConfirmBody": "Khi bị khóa, tài khoản chính không thể sử dụng Luna Reserve. Giữ lượng dùng dưới mức cạn kiệt có thể ngăn việc kích hoạt Reserve. Các tài khoản được thêm vào và provider khác vẫn khả dụng. Các request đang chạy, credential chưa khớp, và lưu lượng ngoài proxy này không được bảo vệ.",

  "codexAuth.mainHardLockConfirm": "Bật bảo vệ",

  "codexAuth.mainHardLockEnabled": "Bảo vệ 99% đang bật.",

  "codexAuth.mainHardLockDisabled": "Bảo vệ 99% đang tắt. Các giới hạn tài khoản khác vẫn được áp dụng.",

  "codexAuth.mainHardLockLoadFailed": "Không thể tải cài đặt này. Hãy thử lại để kiểm tra trạng thái hiện tại của nó.",

  "codexAuth.mainHardLockSaveFailed": "Không thể xác nhận việc lưu. Tải lại cài đặt trước khi thử lại.",

  "codexAuth.mainHardLockRefreshFailed": "Cài đặt đã được lưu, nhưng không thể làm mới trạng thái tài khoản. Vui lòng thử lại.",

  "codexAuth.mainHardLockBlocked": "Bị khóa bởi bảo vệ 99%",

  "codexAuth.mainHardLockUnknown": "Bảo vệ đang bật · lượng sử dụng chưa rõ",

  "codexAuth.mainHardLockMonitoring": "Bảo vệ đang bật · đang theo dõi",

  "codexAuth.mainHardLockManage": "Xem thiết lập bảo vệ",

  "codexAuth.ultraFastDesc": "Ngăn không cho dịch vụ cấp độ Ultra Fast mà bạn đã thiết lập bị loại bỏ khi catalog được tạo lại, và đưa tên nó vào các request log. Nó không thêm Ultra Fast vào bộ chọn model: upstream chỉ quảng cáo Fast, do đó mục chọn sẽ đưa ra tốc độ mà đường truyền không thể đáp ứng.",

  "codexAuth.ultraFastLoadFailed": "Không thể đọc thiết lập Ultra Fast.",

  "codexAuth.ultraFastEnabled": "Cấp độ Ultra Fast đã bật",

  "codexAuth.ultraFastDisabled": "Cấp độ Ultra Fast đã tắt",

  "codexAuth.ultraFastFailed": "Không thể thay đổi thiết lập Ultra Fast",

  "codexAuth.refreshingQuota": "Đang làm mới...",

  "codexAuth.quotaRefreshed": "Đã làm mới quota",

  "codexAuth.quotaRefreshFailed": "Làm mới quota thất bại",

  "codexAuth.pauseExhausted": "Tạm ngưng tài khoản cạn kiệt",

  "codexAuth.pausingExhausted": "Đang kiểm tra quota...",

  "codexAuth.pauseExhaustedSucceeded": "Đã ngưng các tài khoản cạn kiệt: {count}",

  "codexAuth.pauseExhaustedNone": "Không có tài khoản nào được xác nhận đã sử dụng 100%.",

  "codexAuth.pauseExhaustedFailed": "Kiểm tra và ngưng các tài khoản cạn kiệt thất bại.",

  "codexAuth.noPool": "Chưa có tài khoản pool nào được thêm vào.",

  "codexAuth.pause": "Tạm dừng",
  "codexAuth.resume": "Tiếp tục",

  "codexAuth.paused": "ĐÃ TẠM NGƯNG",

  "codexAuth.pauseSucceeded": "{email} đã bị tạm ngưng",

  "codexAuth.resumeSucceeded": "{email} đã có mặt lại trong pool",

  "codexAuth.pauseFailed": "Không thể ngưng {email}. Không có thay đổi nào.",

  "codexAuth.resumeFailed": "Không thể tiếp tục {email}. Không có thay đổi nào.",

  "codexAuth.pausedHint": "Được loại trừ khỏi luân phiên tự động, thử lại, hồi phục sau thời gian chờ, và lựa chọn thủ công cho đến khi tiếp tục.",

  "codexAuth.pinned": "ĐÃ GHIM",

  "codexAuth.pinnedHint": "Bạn đã chọn tài khoản này bằng tay, nên một thứ tự ưu tiên cao hơn sẽ không bỏ qua nó. Việc ghim kéo dài đến khi tài khoản này bị cạn kiệt, bạn chọn một tài khoản khác, hoặc bạn thay đổi bất kỳ thứ tự lựa chọn nào.",

  "codexAuth.fiveHour": "5h",

  "codexAuth.weekly": "Tuần",

  "codexAuth.quotaAutoRefresh": "Tự động kích hoạt cửa sổ",

  "codexAuth.quotaAutoRefreshHint": "Gửi một request warm-up Codex tối thiểu, không lưu trữ khi cửa sổ quota này reset.",

  "codexAuth.quotaAutoRefreshUpdated": "Tự động kích hoạt cửa sổ đã được cập nhật.",

  "codexAuth.quotaAutoRefreshFailed": "Không thể cập nhật tự động kích hoạt cửa sổ.",

  "codexAuth.monthly": "30 ngày",

  "codexAuth.resets": "làm mới",

  "codexAuth.today": "Hôm nay",
  "codexAuth.current": "HIỆN TẠI",

  "codexAuth.nextSession": "ĐÃ CHỌN",

  "codexAuth.poolPrepared": "ĐÃ CHUẨN BỊ CHO POOL",

  "codexAuth.preparePoolTitle": "Chuẩn bị tài khoản này cho chế độ Pool?",

  "codexAuth.preparePoolDesc": "Các request dạng Direct tiếp tục sử dụng đăng nhập chính. Tài khoản này trở thành lựa chọn được chuẩn bị của Pool khi chế độ Pool được bật.",

  "codexAuth.prepareForPool": "Chuẩn bị cho Pool",

  "codexAuth.poolPreparedToast": "{email} đã sẵn sàng cho chế độ Pool",

  "codexAuth.switchTitle": "Chuyển tài khoản đang hoạt động?",

  "codexAuth.switchDesc": "Có hiệu lực ngay lập tức. Các luồng gắn kết với tài khoản đã có và các request đang thực thi sẽ tiếp tục sử dụng tài khoản cũ; các request mới hoặc chưa gán sẽ dùng theo mức ưu tiên của tài khoản mới được chọn, và các tài khoản ở cùng mức độ ưu tiên vẫn sẽ luân phiên.",

  "codexAuth.cacheWarning": "Prompt cache sẽ reset khi chuyển tài khoản. Session mới bắt đầu với cache rỗng.",

  "codexAuth.setAsNext": "Dùng tài khoản này tiếp theo",

  "codexAuth.cancel": "Hủy",
  "codexAuth.switchBack": "Chuyển lại sang Main?",

  "codexAuth.switchBackDesc": "Có hiệu lực ngay lập tức. Các luồng gắn kết với tài khoản đã có và các request đang thực thi sẽ tiếp tục sử dụng tài khoản cũ; các request mới hoặc chưa gán sẽ sử dụng mức ưu tiên của tài khoản đăng nhập App, và các tài khoản ở cùng mức độ ưu tiên vẫn sẽ luân phiên.",

  "codexAuth.autoSwitch": "Luân phiên chủ động theo mức độ sử dụng",

  "codexAuth.autoSwitchQuotaDesc": "Quota: ở mức {threshold}% hoặc cao hơn, request tiếp theo có thể chuyển sang một tài khoản khác đủ điều kiện có mức dùng thấp hơn, bao gồm cả một task đang liên kết; Go/Free chỉ dùng khung 30 ngày.",

  "codexAuth.autoSwitchQuotaOffDesc": "Chuyển tài khoản chủ động dựa trên mức sử dụng đang tắt. Các gán ghép cho tác vụ mới/chưa gắn kết và hồi phục sự cố vẫn hoạt động.",

  "codexAuth.autoSwitchRoundRobinDesc": "Phân bổ luân phiên (Round-robin) không sử dụng ngưỡng này; nó tiếp tục xoay vòng các task mới/chưa gắn kết.",

  "codexAuth.autoSwitchFillFirstDesc": "Ưu tiên làm đầy trước (Fill-first): {threshold}% là điểm chuyển hướng cho các task mới/chưa gắn kết; các task đang liên kết hợp lệ vẫn giữ nguyên tài khoản của chúng.",

  "codexAuth.autoSwitchFillFirstOffDesc": "Ưu tiên làm đầy trước (Fill-first) không có điểm chuyển hướng mức sử dụng cho các task mới/chưa gắn kết; việc hồi chiêu, tái xác thực, và hồi phục sự cố vẫn có thể thay đổi định tuyến.",

  "codexAuth.failureRecoveryNote": "Hồi phục sự cố là một quy trình riêng: một request bị từ chối trước khi có output với 429/402, cooldown, reauthentication, bị loại trừ, hoặc cấu hình chuyển hướng lỗi tạm thời có thể chọn một tài khoản đủ điều kiện khác.",

  "codexAuth.autoSwitchThreshold": "Ngưỡng sử dụng",

  "codexAuth.autoSwitchThresholdAria": "Ngưỡng sử dụng, phần trăm",

  "codexAuth.autoSwitchThresholdInc": "Tăng ngưỡng sử dụng",

  "codexAuth.autoSwitchThresholdDec": "Giảm ngưỡng sử dụng",

  "codexAuth.autoSwitchLoadFailed": "Không thể tải cài đặt chuyển đổi theo mức sử dụng.",

  "codexAuth.autoSwitchThresholdInvalid": "Nhập một số nguyên từ 1 đến 100",

  "codexAuth.autoSwitchUpdated": "Cập nhật chuyển đổi chủ động theo mức độ sử dụng thành công",

  "codexAuth.autoSwitchUpdateFailed": "Không thể xác nhận bản cập nhật chuyển đổi theo mức sử dụng. Đang hiển thị giá trị được xác nhận gần nhất.",

  "codexAuth.requestUserInput": "Yêu cầu người dùng nhập ở chế độ Default",

  "codexAuth.requestUserInputDesc": "Cho phép Codex tạm ngưng một session Default-mode và đặt câu hỏi cho bạn bằng tool request_user_input.",

  "codexAuth.requestUserInputUpdated": "Tính năng đã được cập nhật - áp dụng cho các session mới.",

  "codexAuth.requestUserInputUpdatedRestart": "Tính năng đã được cập nhật - áp dụng cho các session mới. Khởi động lại Codex app để áp dụng.",

  "codexAuth.requestUserInputUpdateFailed": "Không thể cập nhật tính năng. Không có thay đổi nào.",

  "codexAuth.requestUserInputLoadFailed": "Không thể đọc tính năng từ config.toml.",

  "codexAuth.accountPickerTitle": "Chỉ định một tài khoản Codex cụ thể từ bộ chọn model",

  "codexAuth.accountPickerOffDesc": "Khi được bật, các mục chọn model GPT thông thường được thay thế bằng một lựa chọn cho mỗi tài khoản, vì vậy bạn có thể chọn chính xác một tài khoản cho cuộc hội thoại mà không cần đăng xuất. Việc tắt đi không xóa bất kỳ tài khoản nào.",

  "codexAuth.accountPickerOnDesc": "Mỗi bộ chọn là một nhãn công khai cho một tài khoản đã lưu. Chọn nó sẽ khóa cuộc hội thoại đó với tài khoản được gán: nó không bao giờ luân phiên hoặc fallback, và nó không thay đổi tài khoản Pool đang hoạt động.",

  "codexAuth.accountPickerCompatibility": "Tài khoản đăng nhập Codex App tích hợp sẵn có bộ chọn riêng; các liên kết tự tạo thường gọi nó là main và sử dụng hậu tố chống trùng lặp như main-2 khi cần. Các tài khoản được thêm nhận các nhãn an toàn riêng tư, còn các nhãn bộ chọn tùy chỉnh không bị thay đổi. Các cuộc hội thoại hiện có và model đã lưu tiếp tục được định tuyến. Việc tắt tùy chọn này ẩn đi các mục được tạo nhưng vẫn giữ các bộ chọn và các định tuyến chính xác. Các model ID GPT thuần giữ nguyên hành vi Pool hoặc Direct của chúng.",

  "codexAuth.accountPickerUpdated": "Việc nhắm mục tiêu tài khoản đã được cập nhật.",

  "codexAuth.accountPickerUpdateFailed": "Không thể cập nhật việc nhắm mục tiêu tài khoản. Cài đặt được xác nhận gần nhất đang được hiển thị.",

  "codexAuth.accountPickerLoadFailed": "Không thể tải cài đặt nhắm mục tiêu tài khoản.",

  "codexAuth.accountPickerRefreshFailed": "Không thể làm mới cài đặt này. Giá trị được xác nhận gần nhất vẫn đang được hiển thị.",

  "codexAuth.advancedSettings": "Cài đặt nâng cao",

  "codexAuth.advancedSettingsAria": "Hiển thị hoặc ẩn cài đặt xác thực Codex nâng cao",

  "codexAuth.catalogRefreshPending": "Thay đổi đã được lưu, nhưng việc làm mới model catalog của Codex vẫn đang chờ xử lý. Hãy chạy ocx sync để thử lại.",


  "anthropicPool.title": "Claude account pool (thử nghiệm)",

  "anthropicPool.enabledDesc": "Sticky sessions, và các session mới ưu tiên mức sử dụng dưới {threshold}% ({window}).",

  "anthropicPool.enabledNoProactiveDesc": "Sticky sessions. Việc chuyển đổi chủ động dựa trên mức sử dụng đang bị vô hiệu hóa với ngưỡng 0, nhưng việc lựa chọn session mới vẫn sử dụng cửa sổ {window}.",

  "anthropicPool.disabledDesc": "Mỗi session một tài khoản. Lỗi 429 vẫn sẽ chuyển sang một tài khoản khác đã đăng nhập — điều này không thể bị tắt.",

  "anthropicPool.experimentalWarning": "Thử nghiệm và chưa được kiểm chứng đầy đủ. Anthropic có thể giới hạn các tài khoản có vẻ như luân phiên nhiều tài khoản tự động. Cùng một tổ chức có thể chia sẻ quota — gom nhóm các tài khoản đó sẽ không có tác dụng. Vui lòng giữ ở trạng thái tắt trừ khi bạn hiểu rõ rủi ro.",

  "anthropicPool.needTwoAccounts": "Thêm ít nhất hai tài khoản Claude OAuth trước khi kích hoạt pool.",

  "anthropicPool.threshold": "Ngưỡng sử dụng cho session mới",

  "anthropicPool.thresholdAria": "Ngưỡng sử dụng cho session mới, phần trăm",

  "anthropicPool.thresholdHelp": "0 sẽ tắt tính năng lựa chọn dựa trên quota (chỉ giữ ái lực + tài khoản đang hoạt động). Mặc định là 80.",

  "anthropicPool.thresholdInvalid": "Nhập một số nguyên từ 0 đến 100",

  "anthropicPool.loadFailed": "Không thể tải cài đặt Claude pool.",

  "anthropicPool.saveFailed": "Không thể lưu cài đặt Claude pool.",

  "anthropicPool.on": "Bật",

  "anthropicPool.off": "Tắt",


  "accountPool.strategy": "Chiến lược xoay vòng",
  "accountPool.strategyDesc": "Cách OpenCodex chỉ định tài khoản cho một task mới/chưa gắn kết.",

  "accountPool.strategyQuota": "Quota",

  "accountPool.strategyRoundRobin": "Luân phiên",

  "accountPool.strategyFillFirst": "Làm đầy trước",

  "accountPool.strategyHintQuota": "Quota cũng có thể liên kết lại một task đang chạy ở request tiếp theo của nó sau khi vượt qua ngưỡng sử dụng.",

  "accountPool.strategyHintRoundRobin": "Luân phiên (Round-robin) chỉ chuyển đổi các task không có liên kết hiện tại; ngưỡng sử dụng không làm thay đổi việc luân phiên bình thường.",

  "accountPool.strategyHintFillFirst": "Làm đầy trước (Fill-first) sử dụng ngưỡng như là một điểm xả cho các task chưa gắn kết; các task đang liên kết hợp lệ vẫn giữ ái lực.",

  "accountPool.unboundDefinition": "Task mới/chưa gắn kết (new/unbound) nghĩa là một request không có liên kết tài khoản nào hiện tại; một task có thể nhìn thấy có thể trở nên chưa gắn kết sau khi proxy hoặc ái lực bị đặt lại.",

  "accountPool.stickyLimit": "Các tác vụ mới/chưa gắn kết sẽ giữ nguyên trước khi quay vòng",

  "accountPool.stickyLimitAria": "Số lần gán tác vụ mới/chưa gắn kết trước khi xoay vòng",

  "accountPool.stickyLimitInc": "Tăng giới hạn dính",

  "accountPool.stickyLimitDec": "Giảm giới hạn dính",

  "accountPool.stickyLimitHelp": "Giữ tài khoản đã chọn cho số lần gán tác vụ mới/chưa gắn kết này trước khi chuyển sang tài khoản khác; bộ đếm tăng lên khi tác vụ được gắn kết, chứ không phải sau khi upstream thành công.",

  "accountPool.stickyLimitInvalid": "Nhập một số nguyên từ 1 đến 100",

  "accountPool.strategyLoadFailed": "Không thể tải chiến lược luân phiên.",

  "accountPool.strategyUpdateFailed": "Không thể lưu chiến lược luân phiên.",


  // The three window labels double as the {window} name inlined into
  // anthropicPool.enabledDesc, so each locale owns its own inline casing instead of the
  // call site lowercasing a translated string (which breaks for Turkish and CJK).
  "accountPool.quotaWindow": "Cửa sổ Quota",

  "accountPool.quotaWindowDesc": "Thanh trạng thái sử dụng lưu trong cache nào kiểm soát việc chọn session mới dựa trên quota, kiểm tra ngưỡng fill-first, và các bản thay thế 429 đủ điều kiện.",

  "accountPool.quotaWindowFiveHour": "Khung 5 giờ",

  "accountPool.quotaWindowWeekly": "Khung hàng tuần",

  "accountPool.quotaWindowMaxUtilization": "Khung sử dụng cao hơn",

  "accountPool.quotaWindowHint": "Hàng tuần sẽ bỏ qua các tài khoản đã hết mức giới hạn 5 giờ nếu còn tài khoản khác hợp lệ, nhưng sẽ quay về chúng nếu không còn ai khác. Nếu hòa hàng tuần, tài khoản có mức 5 giờ thấp hơn sẽ được ưu tiên; mức hàng tuần cho mỗi tài khoản chỉ được biết sau khi trang Providers đã lấy dữ liệu.",

  "accountPool.quotaWindowInert": "Chỉ chiến lược Quota — hoặc Fill-first khi lớn hơn ngưỡng 0 — mới lấy điểm đánh giá mức sử dụng, nên cài đặt này không có tác dụng đối với chiến lược luân phiên hiện tại.",


  // Selection order. User-visible copy stays in sequence words (first/earlier/later/last);
  // only identifiers use the internal "priority" name.
  "accountPool.priority": "Thứ tự chọn",
  "accountPool.priorityAria": "Thứ tự ưu tiên cho tài khoản này",

  "accountPool.priorityHint": "Số càng cao càng được sử dụng trước. Pool chuyển xuống một số ưu tiên thấp hơn chỉ khi tất cả các tài khoản ở mức trên bị cạn kiệt hoặc không khả dụng.",

  "accountPool.priorityFirst": "Đầu tiên",

  "accountPool.priorityEarlier": "Sớm hơn",

  "accountPool.priorityNormal": "Thông thường",
  "accountPool.priorityLater": "Muộn hơn",

  "accountPool.priorityLast": "Cuối cùng",

  "accountPool.priorityOption": "{name} ({value})",

  "accountPool.priorityCustom": "Tùy chỉnh",
  "accountPool.priorityUpdated": "Đã cập nhật thứ tự ưu tiên cho {email}",

  "accountPool.priorityUpdateFailed": "Không thể lưu thứ tự lựa chọn cho {email}. Giá trị được xác nhận gần nhất đang được hiển thị.",


  "codexAuth.switched": "Tài khoản được chọn cho request tiếp theo là {email}",

  "codexAuth.loadFailed": "Không thể tải cài đặt tài khoản Codex.",

  "codexAuth.switchFailed": "Không thể chuyển đổi tài khoản. Tùy chọn trước đó của bạn vẫn được giữ nguyên.",

  "codexAuth.removeConfirm": "Gỡ bỏ {id}?",

  "codexAuth.removeFailed": "Không thể gỡ bỏ tài khoản. Không có thay đổi nào.",

  "codexAuth.addTitle": "Thêm tài khoản Codex",

  "codexAuth.addIdLabel": "ID tài khoản (slug)",

  "codexAuth.addIdPlaceholder": "codex-work, codex-alt, team...",

  "codexAuth.resetCreditsAria": "{count} credit reset",

  "codexAuth.addJsonLabel": "Nội dung auth.json",

  "codexAuth.addHelp": "Sao chép từ ~/.codex/auth.json trên một máy khác, hoặc sử dụng codex-auth export.",

  "codexAuth.importBtn": "Nhập (Import)",

  "codexAuth.importInvalidJson": "JSON không hợp lệ",

  "codexAuth.importMissingTokens": "Thiếu access_token hoặc refresh_token trong JSON",

  "codexAuth.importMissingId": "Account ID là bắt buộc",

  "codexAuth.accountAdded": "Tài khoản đã được thêm vào pool",

  "codexAuth.addPickDesc": "Đăng nhập bằng một tài khoản ChatGPT khác để thêm nó vào pool.",

  "codexAuth.oauthLogin": "Đăng nhập bằng OAuth",

  "codexAuth.oauthDesc": "Mở trang đăng nhập ChatGPT trong trình duyệt",

  "codexAuth.deviceLogin": "Đăng nhập qua device code",

  "codexAuth.deviceDesc": "Dành cho máy chủ headless hoặc proxy từ xa: nhập mã ngắn này trên một thiết bị khác",

  "codexAuth.importAuthJson": "Nhập auth.json",

  "codexAuth.importAuthJsonDesc": "Từ một bản Codex khác hoặc thông qua export codex-auth",

  "codexAuth.back": "Quay lại",
  "codexAuth.oauthAlreadyInProgress": "Đang tiến hành đăng nhập. Vui lòng hoàn tất quá trình này trong trình duyệt của bạn.",

  "codexAuth.oauthWaiting": "Đang đợi quá trình đăng nhập ChatGPT hoàn tất trên trình duyệt...",

  "codexAuth.oauthSubmittingCode": "Đang gửi mã…",

  "codexAuth.oauthCodeSubmitted": "Đã gửi mã — đang đợi đăng nhập hoàn tất…",

  "codexAuth.oauthStatusRetrying": "Lỗi mạng hoặc proxy trong khi kiểm tra trạng thái đăng nhập — đang thử lại…",

  "codexAuth.oauthCancelled": "Quá trình đăng nhập đã bị hủy.",

  "codexAuth.loginFailed": "Đăng nhập thất bại",

  "codexAuth.needsReauth": "Đăng nhập lại",

  "codexAuth.reauthenticate": "Xác thực lại",

  "codexAuth.tokenExpired": "Token hết hạn — hãy xác thực lại tài khoản này",

  "codexAuth.mainTokenExpired": "Token hết hạn — vui lòng đăng nhập lại thông qua Codex App login",

  "codexAuth.emailCollision": "Tài khoản này trùng với lần đăng nhập Codex chính của bạn. Vui lòng dùng tài khoản khác.",


  "codexAuth.resetCreditsTitle": "Đặt lại Credits",

  "codexAuth.resetCreditsAvailable": "Bạn đang có sẵn {count} credit reset.",

  "codexAuth.resetCreditsDesc": "Mỗi credit reset ngay lập tức các giới hạn sử dụng hàng giờ và hàng tuần hiện tại của bạn.",

  "codexAuth.noResetCredits": "Bạn không có credit reset nào.",

  "codexAuth.earnCreditsHint": "Credit được thưởng hàng tháng và qua chương trình giới thiệu (referral program).",

  "codexAuth.creditsExpireNote": "Credit hết hạn sau 30 ngày kể từ khi kiếm được.",

  "codexAuth.useOneCredit": "Sử dụng 1 Credit",

  "codexAuth.confirmResetTitle": "Sử dụng Reset Credit?",

  "codexAuth.confirmResetDesc": "Thao tác này sẽ reset ngay lập tức các giới hạn tỉ lệ hiện tại của bạn. Bạn còn lại {count} credit.",

  "codexAuth.irreversible": "Hành động này không thể hoàn tác.",

  "codexAuth.useCredit": "Dùng Credit",

  "codexAuth.redeeming": "Đang reset...",

  "codexAuth.resetSuccess": "Đã reset các giới hạn sử dụng! Bạn còn lại {remaining} credit.",

  "codexAuth.resetSuccessGeneric": "Đã reset các giới hạn sử dụng!",

  "codexAuth.resetAlreadyRedeemed": "Credit này đã được sử dụng. Số lượng credit không thay đổi.",

  "codexAuth.resetNothingToReset": "Hiện không có cửa sổ hạn mức nào cần reset.",

  "codexAuth.resetNoCredit": "Không có reset credit nào.",

  "codexAuth.resetError": "Không thể đổi reset credit. Vui lòng thử lại.",

  "codexAuth.fifoNote": "Credit cũ nhất sẽ được dùng trước.",

  "codexAuth.confirmWhichCredit": "Credit từ ngày {date} sẽ được sử dụng.",

  "codexAuth.creditNext": "Sắp dùng tới",

  "codexAuth.creditLabel": "Credit #{n}",

  "codexAuth.creditNextBadge": "NEXT",

  "codexAuth.creditGranted": "Được cấp vào {date}",

  "codexAuth.creditExpires": "Hết hạn vào {date} (còn lại {days} ngày)",


  // api access page
  "api.title": "Truy cập API",

  "api.subtitle": "Sử dụng các API key được tạo để truy cập proxy opencodex từ các ứng dụng bên ngoài. API key được xác thực qua header {authHeader}; xem bảng bên dưới để biết mỗi endpoint hỗ trợ những gì.",

  "api.baseUrl": "Base URL",

  "api.responsesEndpoint": "Responses API",

  "api.chatCompletionsEndpoint": "Chat Completions API",

  "api.messagesEndpoint": "Messages API",

  "api.modelsEndpoint": "Models API",

  "api.endpointNote": "Dùng URL cơ sở cho các ứng dụng hỗ trợ OpenAI tương thích. Responses và Chat Completions được đặt ở /v1.",

  "api.endpointsTitle": "Endpoints",

  "api.authTitle": "Xác thực (Authentication)",

  "api.authLoopback": "Kết nối Loopback (127.0.0.1 hoặc ::1) bỏ qua xác thực. Các kết nối từ xa yêu cầu một API key tạo sẵn bằng tiền tố ocx_ hoặc OPENCODEX_API_AUTH_TOKEN.",

  "api.authBaseUrlNote": "Cấu hình client bằng URL cơ sở, sau đó chọn một endpoint cụ thể theo giao thức ở bên dưới.",

  "api.newKeyTitle": "Đã tạo key mới",

  "api.newKeyNote": "Sao chép key này ngay bây giờ — nó sẽ không hiển thị lại nữa.",

  "api.copy": "Sao chép",
  "api.copied": "Đã sao chép",
  "api.dismiss": "Bỏ qua",

  "api.generateTitle": "Tạo key",

  "api.keyNamePlaceholder": "Tên key (tùy chọn)",

  "api.generate": "Tạo",

  "api.generating": "Đang tạo…",

  "api.activeKeys": "Các key đang kích hoạt ({count})",

  "api.activeKeysLoading": "Các key đang kích hoạt",

  "api.noKeys": "Chưa có API key nào. Hãy tạo một key ở trên.",

  "api.workspace.sections": "Các phân hệ API",

  "api.section.keys": "Keys",

  "api.section.connect": "Kết nối",

  "api.section.endpoints": "Endpoints",

  "api.section.models": "Models",

  "api.section.examples": "Ví dụ",

  "api.workspace.details": "Chi tiết API key",

  "api.workspace.keyDetails": "Chi tiết Key",

  "api.workspace.keyPrefix": "Tiền tố key",

  "api.workspace.deleteKey": "Xóa key",

  "api.workspace.deleteConfirm": "Bạn có chắc chắn muốn xóa key này? Hành động này không thể hoàn tác.",

  "api.workspace.usageExamples": "Ví dụ cách dùng",

  "api.copyUrlHint": "Nhấp để chép URL",

  "api.urlCopied": "Đã chép URL",

  "api.copyExampleHint": "Nhấp để chép ví dụ",

  "api.exampleCopied": "Đã chép ví dụ",

  "api.colName": "Tên",
  "api.colKey": "Key",

  "api.colCreated": "Tạo ngày",

  "api.confirm": "Xác nhận",

  "api.deleteAria": "Xóa API key",

  "api.modelsTitle": "Danh mục model bên ngoài",

  "api.modelsCount": "{count} có thể gọi được",

  "api.modelsLoading": "Đang tải các model…",

  "api.modelsSearch": "Tìm model",

  "api.modelsSubtitle": "Dùng chính xác các ID model này với /v1/models và giao thức đầu vào bạn đã chọn.",

  "api.modelsEmpty": "Chưa có model bên ngoài nào khả dụng để gọi.",

  "api.modelsNoMatch": "Không có model nào khớp với “{query}”.",

  "api.modelsLoadFailed": "Không thể tải danh sách model bên ngoài.",

  "api.colModel": "Model",

  "api.colSource": "Nguồn (Source)",

  "api.colProtocols": "Giao thức",

  "api.sourceNative": "ChatGPT pool",

  "api.sourceCombo": "Định tuyến hỗn hợp",

  "api.sourceCustom": "Tùy chỉnh",
  "api.protocolResponses": "Responses",

  "api.protocolChatCompletions": "Chat Completions",

  "api.protocolMessages": "Messages",

  "api.copyModelId": "Sao chép ID",

  "api.modelCopied": "Đã sao chép",
  "api.testModel": "Kiểm tra",

  "api.testingModel": "Đang kiểm tra…",

  "api.testSucceeded": "OK",

  "api.testFailed": "Thất bại",

  "api.usageChatTitle": "Ví dụ Chat Completions",

  "api.usageResponsesTitle": "Ví dụ Responses",

  "api.usageMessagesTitle": "Ví dụ Messages",

  "api.usageSampleInput": "Xin chào, thế giới!",

  "api.clientConfig.title": "Cấu hình Client",

  "api.clientConfig.rowsLabel": "Kết nối một client",

  "api.clientConfig.details": "Chi tiết",
  "api.clientConfig.detailsAria": "Chi tiết cấu hình {client}",

  "api.clientConfig.copyAria": "Sao chép cấu hình {client}",

  "api.clientConfig.downloadAria": "Tải cấu hình {client}",

  "api.clientConfig.rowMeta": "{destination} · {count} model",

  "api.clientConfig.rowError": "Không thể xây dựng cấu hình {client}.",

  "api.clientConfig.copiedAnnounceClient": "Cấu hình {client} đã được chép vào clipboard.",

  "api.clientConfig.clientOpencode": "OpenCode",

  "api.clientConfig.clientPi": "Pi",

  "api.clientConfig.clientOmp": "OMP",

  "api.clientConfig.clientHermes": "Hermes",

  "api.clientConfig.clientOpenclaw": "OpenClaw",

  "api.clientConfig.clientKimi": "Kimi Code",

  "api.clientConfig.clientGajae": "Gajae Code",

  "api.clientConfig.clientDsh": "DeepSeek Harness (DSH)",

  "api.clientConfig.clientMcode": "MiniMax Code",

  "api.clientConfig.clientZcode": "ZCode",

  "api.clientConfig.clientPrime": "Prime Agent",

  "api.clientConfig.clientAside": "Aside",

  "api.clientConfig.clientRaycast": "Raycast",

  "api.clientConfig.copy": "Sao chép cấu hình",

  "api.clientConfig.download": "Tải xuống",

  "api.clientConfig.loading": "Đang xây dựng cấu hình client…",

  "api.clientConfig.jsonLabel": "Cấu hình {client}",

  "api.clientConfig.destination": "Tệp đích",

  "api.clientConfig.envHint": "Thiết lập khóa trước khi khởi chạy",

  "api.clientConfig.mergeWarning": "Gộp nội dung này vào tệp đích. Nếu ghi đè hoàn toàn, bạn sẽ mất các cài đặt MCP và provider khác.",

  "api.clientConfig.modelCount": "Đã xuất {count} model",

  "api.clientConfig.missingLimits": "{count} trong số {total} model được phân phối không có giới hạn ngữ cảnh (context limit); client sẽ áp dụng các giá trị mặc định của riêng nó.",

  "api.clientConfig.noKeyYet": "{env} hiện chưa có khóa. Hãy tạo một khóa ở trên trước khi sử dụng cấu hình này bên ngoài loopback.",

  "api.clientConfig.loadFailed": "Không thể đọc danh sách model, do đó không có cấu hình client nào được tạo ra.",

  "api.clientConfig.copiedAnnounce": "Cấu hình client đã được sao chép vào khay nhớ tạm.",

  "api.clientConfig.copyFailed": "Không thể sao chép cấu hình client.",

  "api.clientConfig.downloadedAnnounce": "Đã tải xuống {filename}. Chưa có thay đổi nào được áp dụng — hãy tự gộp nó vào {destination}.",

  "api.clientConfig.whereDisclosure": "Tệp này được lưu ở đâu",

  "api.clientConfig.whereBody": "Đích đến ở trên là đường dẫn toàn cục (global path). Một tệp cấu hình project-local trong thư mục làm việc sẽ được ưu tiên cao hơn, và client sẽ đọc khóa từ biến môi trường (environment variable) được chỉ định trong cấu hình — chứ không bao giờ đọc từ tệp này.",

  "api.keysLoadFailed": "Không thể tải các khóa API.",

  "api.createFailed": "Không thể tạo khóa API.",

  "api.deleteFailed": "Không thể xóa khóa API.",

  "api.auth.endpoint": "Endpoint",

  "api.auth.required": "Bắt buộc",

  "api.auth.accepted": "Được chấp nhận",

  "api.auth.rejected": "Không được chấp nhận",

  "api.auth.testProtocol": "Kiểm tra {protocol}",

  "api.auth.testNeedsFreshKey": "Tạo một khóa và giữ giá trị hiển thị một lần của nó trên màn hình để chạy một bài kiểm tra xác thực (authenticated test).",

  "api.key.name": "Tên khóa",

  "api.key.rename": "Đổi tên",

  "api.key.saveName": "Lưu tên",

  "api.key.renaming": "Đang lưu…",

  "api.key.renameFailed": "Không thể đổi tên khóa. Bản nháp của bạn đã được giữ lại.",

  "api.key.deleting": "Đang xóa…",

  "api.rotation.title": "Luân chuyển khóa",

  "api.rotation.description": "Cấp phát một khóa thay thế trong khi khóa hiện tại vẫn giữ hiệu lực trong một khoảng thời gian gối đầu ngắn.",

  "api.rotation.start": "Bắt đầu luân chuyển",

  "api.rotation.starting": "Đang bắt đầu…",

  "api.rotation.pending": "Quá trình luân chuyển đang chờ xử lý. Hãy cập nhật và xác minh client trước khi xác nhận (commit).",

  "api.rotation.expires": "Thời gian gối đầu (overlap) hết hạn lúc:",

  "api.rotation.secretOnce": "Khóa thay thế — chỉ hiển thị một lần. Hãy sao chép nó trước khi đóng thông báo này.",

  "api.rotation.commit": "Xác nhận luân chuyển",

  "api.rotation.abort": "Hủy luân chuyển",

  "api.rotation.failed": "Hành động luân chuyển không thể hoàn tất. Hãy làm mới trước khi thử lại.",

  "api.rotation.startFailed": "Không thể bắt đầu luân chuyển khóa.",

  "api.key.copyFailed": "Không thể sao chép khóa. Hãy chọn và sao chép thủ công trước khi đóng bảng này.",

  "api.attribution.title": "Mức sử dụng được quy kết",

  "api.attribution.requests7d": "Số requests, 7 ngày qua",

  "api.attribution.totalRequests": "Tổng số requests được quy kết",

  "api.attribution.totalRequestsAvailable": "Số requests trong lịch sử hiện có",

  "api.attribution.sinceAvailable": "Dữ liệu quy kết có sẵn từ",

  "api.attribution.lastUsed": "Lần sử dụng cuối",

  "api.attribution.since": "Dữ liệu quy kết có sẵn từ",

  "api.attribution.neverUsed": "Chưa được sử dụng kể từ khi bắt đầu quy kết",

  "api.attribution.unavailable": "Không có dữ liệu sử dụng",

  "api.attribution.unavailableDetail": "Chưa có mức sử dụng nào được quy kết. Các requests được ghi nhận trước khi tính năng quy kết bắt đầu sẽ không thể được gán hồi tố.",

  "api.attribution.ambiguous": "Có hai khóa dùng chung ID này, do đó không thể quy kết mức sử dụng cho một trong số chúng. Hãy cung cấp cho mỗi khóa một ID duy nhất trong tệp cấu hình.",

  "api.attribution.railAmbiguous": "trùng ID",

  // Claude Code inbound
  "claude.subtitle": "Sử dụng GPT, Gemini và các model khác bên trong Claude Code.",

  "claude.pageTitle": "Claude Code",

  "claude.workspace.settings": "Cài đặt",
  "claude.enabledLabel": "Kết nối Claude",

  "claude.enabledHint": "Khi tắt, Claude Code không thể sử dụng proxy này.",

  "claude.authMode": "Chế độ xác thực",

  "claude.authModeHint": "Chế độ Subscription yêu cầu tài khoản Claude, chế độ Proxy hoạt động mà không cần tài khoản Anthropic",

  "claude.authModeSubscription": "Subscription (Tài khoản Claude)",

  "claude.authModeProxy": "Proxy (Không cần tài khoản)",

  "claude.authModeAuto": "Auto (Tự động phát hiện xác thực Claude)",

  "claude.effectiveMode.label": "Sẽ có hiệu lực ở lần khởi chạy tiếp theo",

  "claude.effectiveMode.manual": "Thủ công: {mode}",

  "claude.effectiveMode.autoPresent": "Tự động: subscription — tìm thấy xác thực Claude thông qua {source}",

  "claude.effectiveMode.autoAbsent": "Tự động: chế độ proxy — không tìm thấy xác thực Claude",

  "claude.effectiveMode.autoUnknown": "Tự động: subscription — không thể xác minh xác thực",

  "claude.effectiveMode.admissionKey": "Khóa API của proxy này vẫn được gửi đi.",

  "claude.authSource.claude-json-oauth": "tài khoản Claude",

  "claude.authSource.claude-credentials-file": "tệp credentials",

  "claude.authSource.macos-keychain": "macOS Keychain",

  "claude.authSource.exported-env": "biến môi trường (environment variable)",

  "claude.authSource.unknown": "một credential được phát hiện",

  "claude.systemEnv": "Tự động kết nối",

  "claude.systemEnvDesc": "Khi bật, việc chạy claude trong bất kỳ terminal nào cũng sẽ tự động đi qua proxy.",

  "claude.systemEnvUnsupported": "Tự động kết nối chỉ khả dụng trên macOS. Trên hệ thống này, hãy khởi chạy Claude bằng {cmd}.",

  "claude.systemEnvWarn": "⚠ Bạn phải thoát hoàn toàn và mở lại ứng dụng terminal để thay đổi này có hiệu lực. Không khuyến khích.",

  "claude.fastMode": "Chế độ Fast (OpenAI)",

  "claude.fastModeDesc": "Kiểm soát service_tier cho các model OpenAI. ON = priority (nhanh hơn). OFF = default. Auto = passthrough (client tự quyết định).",

  "claude.fastAuto": "Tự động",

  "claude.fastOn": "BẬT",

  "claude.fastOff": "TẮT",

  "claude.autoContext": "Tự động sử dụng ngữ cảnh lớn (big context)",

  "claude.autoContextDesc": "Kiểm soát phạm vi áp dụng nhãn 1M. ON: bất kỳ model nào có cửa sổ (window) đủ lớn để chứa ngưỡng nén (compaction threshold) đều sẽ có hàng big-context. OFF: chỉ những model thực sự đạt 1M mới có.",

  "claude.autoContextInert": "Bị vô hiệu hóa vì giá trị kích thước ngữ cảnh (maxContextTokens) cũ vẫn tồn tại trong tệp cấu hình. Hãy xóa nó ở đó để kích hoạt lại.",

  "claude.autoCompactWindow": "Điểm tự động tóm tắt",

  "claude.autoCompactDefault": "{value} (mặc định)",

  "claude.autoCompactWindowDesc": "Các tin nhắn cũ hơn sẽ được tóm tắt khi cuộc trò chuyện đạt đến điểm này. Nó không bao giờ vượt qua giới hạn riêng của từng model, do đó các model 200k sẽ không bị ảnh hưởng.",

  "claude.autoCompactWindowWarn": "Việc thay đổi điều này có thể làm hỏng các model GPT — nếu đặt cao hơn giới hạn thực của model, các cuộc trò chuyện sẽ gặp lỗi trước khi quá trình tóm tắt bắt đầu.",

  "claude.injectAgents": "Tự động đăng ký các subagent",

  "claude.injectAgentsDesc": "Đăng ký các model được chọn trên thẻ Subagents (cộng với model mặc định hiện tại) làm các agent Claude Code có thể điều phối (ocx-*). Có hiệu lực từ phiên làm việc tiếp theo.",

  "claude.webSearchSidecar": "Ghi đè sidecar tìm kiếm web",

  "claude.webSearchSidecarHint": "Ghi đè sidecar tìm kiếm web chính đối với các yêu cầu từ Claude Code.",

  "claude.visionSidecar": "Ghi đè sidecar thị giác (vision sidecar)",

  "claude.visionSidecarHint": "Ghi đè sidecar thị giác chính đối với các yêu cầu từ Claude Code.",

  "claude.useMainSetting": "Sử dụng thiết lập chính",

  "claude.sidecarModelPlaceholder": "Model thiết lập chính",

  "claude.quickstart": "Bắt đầu",

  "claude.quickstartHint": "{cmd} sẽ mở Claude Code thông qua proxy. Phiên đăng nhập claude.ai của bạn vẫn được giữ nguyên.",

  "claude.manualEnv": "Thiết lập thủ công (nâng cao)",

  "claude.smallFastModel": "Model hỗ trợ nền (Background helper model)",

  "claude.smallFastModelHint": "Model mà Claude Code sử dụng cho các tác vụ nền như tóm tắt trò chuyện và phát hiện chủ đề. Bí danh (alias) của subagent haiku cũng sử dụng nó. Bỏ trống = Mặc định của Claude (Haiku).",

  "claude.smallFastModelAccurateHint": "Model mà Claude Code sử dụng cho các tác vụ nền như tóm tắt trò chuyện và phát hiện chủ đề. Bí danh của subagent haiku cũng sử dụng nó.",

  "claude.smallFastModelUnsetOption": "Để Claude Code tự chọn (native model)",

  "claude.smallFastModelNativeWarning": "Khi bỏ trống, OpenCodex sẽ không ghi đè model hỗ trợ (helper-model). Claude Code có thể sử dụng model Sonnet gốc của nó, điều này có thể phát sinh chi phí từ provider gốc của bạn.",

  "claude.slotUnset": "Sử dụng mặc định của Claude",

  "claude.modelMap": "Đánh chặn model (Model interception)",

  "claude.modelMapHint": "Đánh chặn các yêu cầu đến một model cụ thể và định tuyến lại sang model bạn chọn. Mặc định là trống — sẽ không có gì xảy ra cho đến khi bạn thêm một quy tắc (rule).",

  "claude.mapFrom": "Model gốc (ví dụ: claude-sonnet-4-5)",

  "claude.mapTo": "Chuyển đổi thành (ví dụ: gemini/gemini-3-pro)",

  "claude.addMapping": "Thêm quy tắc",

  "claude.removeMapping": "Xóa quy tắc",

  "claude.aliases": "Các model có sẵn",

  "claude.aliasesHint": "Các model xuất hiện trong menu /model của Claude Code.",

  "claude.aliasProviderOther": "Khác",

  "claude.loading": "Đang tải…",
  "claude.loadFail": "Không thể tải cài đặt Claude",

  "claude.saved": "Đã lưu.",

  "claude.saveFailed": "Lưu thất bại",

  "claude.networkError": "Lỗi mạng — proxy có đang chạy không?",

  "claude.toggleAria": "Bật/tắt kết nối Claude",

  "claude.none": "Không có",

  // Combos workspace
  "cws.loading": "Đang tải các combo…",

  "cws.loadFailed": "Không thể tải các combo.",

  "cws.saveFailed": "Không thể lưu combo.",

  "cws.removeFailed": "Không thể xóa combo.",

  "cws.saved": "Đã lưu combo.",

  "cws.created": "Đã tạo {model}.",

  "cws.removed": "Đã xóa combo/{id}.",

  "cws.renamed": "Đã đổi tên {from} thành {to}.",

  "cws.add": "Thêm combo",

  "cws.addTitle": "Thêm combo",

  "cws.addSubtitle": "Tạo một model ảo (virtual model) xuyên suốt các provider và chọn chính xác tên model mà các client sẽ gọi.",

  "cws.create": "Tạo combo",

  "cws.railAria": "Danh sách combo",

  "cws.searchPlaceholder": "Tìm kiếm combo hoặc mục tiêu (target)…",

  "cws.noSearchResults": "Không có combo nào khớp với tìm kiếm của bạn.",

  "cws.group.failover": "Failover",

  "cws.group.roundRobin": "Round-robin",

  "cws.group.other": "Các chiến lược khác",

  "cws.targetCount": "{count} mục tiêu",

  "cws.targetCountOne": "1 mục tiêu",

  "cws.overviewTitle": "Combos",

  "cws.overviewBlurb": "Các model ảo thực hiện định tuyến qua các mục tiêu provider/model với các cơ chế như failover, round-robin, weighted random (ngẫu nhiên có trọng số), least-used (ít được sử dụng nhất), hoặc soonest quota reset (đặt lại hạn ngạch sớm nhất).",

  "cws.count.total": "Tổng cộng",

  "cws.count.failover": "Failover",

  "cws.count.roundRobin": "Round-robin",

  "cws.count.other": "Khác",

  "cws.howTitle": "Cách thức hoạt động",

  "cws.howBody": "Hỏi Codex về tên model công khai (public model name) của combo. Nếu không có, mặc định sẽ là combo/<id>. OpenCodex sẽ chọn một mục tiêu và chỉ chuyển sang mục tiêu khác (hop) khi gặp các lỗi từ upstream có thể thử lại. Nếu không còn mục tiêu nào khả dụng, yêu cầu sẽ bị từ chối (fails closed) thay vì sử dụng provider mặc định toàn cục.",

  "cws.attentionTitle": "Cần chú ý",

  "cws.attention.empty": "Chưa có mục tiêu nào được cấu hình",

  "cws.attention.few": "Chỉ có một mục tiêu — tính năng failover sẽ không có nơi nào để chuyển tiếp (hop)",

  "cws.attention.catalogOmitted": "Bị thiếu khỏi danh mục model (model catalog) — các khả năng của thành viên bị thiếu hoặc không tương thích (thiếu cửa sổ ngữ cảnh / metadata, hoặc giao điểm phương thức bị rỗng). Tính năng định tuyến qua bí danh (alias) vẫn hoạt động",

  "cws.attention.allTargetsExhausted": "Tất cả các mục tiêu được bật đều đã hết hạn ngạch (quota)",

  "cws.emptyTitle": "Tạo combo đầu tiên của bạn",

  "cws.empty.createDesc": "Đặt tên cho một model ảo và liên kết hai hoặc nhiều backend với nhau.",

  "cws.backToAll": "Quay lại tất cả combo",

  "cws.allCombos": "Tất cả combo",

  "cws.copyModel": "Sao chép id",

  "cws.copied": "Đã sao chép",
  "cws.tabsLabel": "Các phần chi tiết của combo",

  "cws.tab.config": "Cấu hình",

  "cws.tab.about": "Thông tin",

  "cws.strategy": "Chiến lược",

  "cws.strategy.failover": "Failover",

  "cws.strategy.roundRobin": "Round-robin",

  "cws.strategy.random": "Ngẫu nhiên",

  "cws.strategy.leastUsed": "Ít được sử dụng nhất (Least-used)",

  "cws.strategy.resetWindow": "Reset-window",

  "cws.strategy.failoverHint": "Thử các mục tiêu theo thứ tự. Nếu mục tiêu đầu tiên gặp lỗi có thể thử lại (rate limit, mất kết nối, chặn subscription), sẽ chuyển tiếp (hop) sang mục tiêu tiếp theo.",

  "cws.strategy.roundRobinHint": "Cân bằng lưu lượng một cách tất định (deterministically) theo trọng số. Giữ nguyên mục tiêu được chọn cho một loạt các yêu cầu thành công, sau đó chuyển sang mục tiêu tiếp theo.",

  "cws.strategy.randomHint": "Rút ngẫu nhiên một mục tiêu đủ điều kiện cho mỗi yêu cầu, với tỷ lệ thuận theo trọng số. Không giữ nguyên trạng thái (stickiness) giữa các yêu cầu.",

  "cws.strategy.leastUsedHint": "Định tuyến từng yêu cầu đến mục tiêu đủ điều kiện có số lượng thành công được ghi nhận ít nhất. Số đếm sẽ khởi động lại cùng với proxy.",

  "cws.strategy.resetWindowHint": "Ưu tiên mục tiêu đủ điều kiện có thời gian đặt lại hạn ngạch (quota window) sớm nhất. Sẽ chuyển về thứ tự cấu hình khi dữ liệu hạn ngạch bị thiếu.",

  "cws.field.id": "Id của combo",

  "cws.field.idHint": "Các client sẽ gửi yêu cầu tới {model}",

  "cws.field.idInternalHint": "Id nội bộ của combo. Bạn có thể thay đổi nó sau khi tạo.",

  "cws.field.idHintEdit": "Việc đổi tên sẽ chuyển combo sang một id mới. Các client sẽ gửi yêu cầu tới {model}.",

  "cws.field.alias": "Tên model công khai (Public model name)",

  "cws.field.aliasPlaceholder": "deepseek-v4-flash hoặc vendor/model",

  "cws.field.aliasHint": "Tùy chọn. Sử dụng một tên trần (bare name) không có tiền tố, một tiền tố tùy chỉnh như vendor/model, hoặc để trống để sử dụng combo/<id>.",

  "cws.field.nativeAlias": "Bí danh OpenAI gốc (Native OpenAI alias)",

  "cws.field.nativeAliasHint": "Cho phép combo này sở hữu một id model OpenAI gốc (unqualified) được hỗ trợ. Các định tuyến OpenAI được chỉ định qua tài khoản và provider sẽ được giữ tách biệt.",

  "cws.field.displayName": "Tên hiển thị",

  "cws.field.displayNameHint": "Nhãn hiển thị trên bộ chọn (picker) cho combo này. Bắt buộc khi tính năng Bí danh OpenAI gốc (Native OpenAI alias) được bật.",

  "cws.field.stickyLimit": "Số lần thành công giữ nguyên trước khi xoay vòng (rotate)",

  "cws.field.stickyLimitHint": "Giữ nguyên mục tiêu được chọn cho từng này yêu cầu thành công trước khi bộ chọn theo trọng số (weighted selector) chuyển tiếp.",

  "cws.field.defaultEffort": "Suy luận (reasoning) mặc định",

  "cws.field.defaultEffortNone": "Không (mặc định của mục tiêu)",

  "cws.field.defaultEffortHint": "Chỉ sử dụng khi client không chỉ định mức độ suy luận (reasoning effort). Các tùy chọn là giao điểm của các mức độ được công bố từ các mục tiêu đã chọn; những mục tiêu không có metadata về mức độ suy luận trong danh mục sẽ không cung cấp tùy chọn này.",

  "cws.capability.imageInputUnavailable": "Không khả dụng cho đến khi mọi mục tiêu được chọn đều hỗ trợ đầu vào hình ảnh (image input).",

  "cws.capability.imageInputHint": "Được bật theo mặc định khi mọi mục tiêu đều hỗ trợ hình ảnh. Tắt để chỉ chấp nhận văn bản.",

  "cws.capability.imageInput": "Hình ảnh / đa phương thức (multimodal)",

  "cws.capability.adaptiveEffort": "Thang suy luận thích ứng (Adaptive reasoning ladder)",

  "cws.capability.adaptiveEffortHint": "Tắt: một mục tiêu không có kiểm soát suy luận sẽ ẩn đi bộ chọn mức độ (effort picker) cho toàn bộ combo. Bật: những mục tiêu đó vẫn có thể sử dụng và bộ chọn sẽ giữ lại các cấp độ mà các mục tiêu còn lại dùng chung.",

  "cws.capabilities": "Khả năng (Capabilities)",

  "cws.field.defaultEffortUnsupported": "Mức độ (effort) này không nằm trong thang dùng chung của các mục tiêu — nó sẽ bị bỏ qua hoặc tự điều chỉnh vào thời điểm gửi yêu cầu.",

  "cws.field.defaultEffortUnsupportedOption": "không nằm trong giao điểm",

  "cws.targets": "Mục tiêu (Targets)",

  "cws.targets.failoverHint": "Thứ tự rất quan trọng — mục tiêu đầu tiên là ưu tiên chính (primary).",

  "cws.targets.roundRobinHint": "Trọng số kiểm soát việc lựa chọn tương đối một cách tất định; thứ tự sẽ phá vỡ thế cân bằng (tie-breaker) trong vòng xoay (rotation ring).",

  "cws.targets.randomHint": "Trọng số kiểm soát tỷ lệ cược của mỗi lần rút (draw); thứ tự không quan trọng.",

  "cws.targets.leastUsedHint": "Thứ tự chỉ dùng để phá vỡ thế cân bằng giữa các mục tiêu được sử dụng với tần suất như nhau.",

  "cws.targets.resetWindowHint": "Thứ tự được áp dụng khi dữ liệu hạn ngạch bị thiếu hoặc ngang bằng nhau.",

  "cws.target.provider": "Nhà cung cấp",

  "cws.target.model": "Model",

  "cws.target.weight": "Trọng số (Weight)",

  "cws.target.pickProvider": "Chọn provider…",

  "cws.target.pickProviderFirst": "Hãy chọn một provider trước…",

  "cws.target.pickModel": "Chọn model…",

  "cws.target.noModels": "Không có model nào cho provider này",

  "cws.target.modelPlaceholder": "id của model",

  "cws.target.add": "Thêm mục tiêu",

  "cws.target.drag": "Kéo để sắp xếp lại",

  "cws.target.moveUp": "Di chuyển lên",

  "cws.target.moveDown": "Di chuyển xuống",

  "cws.quota.available": "Khả dụng",
  "cws.quota.exhausted": "Hết hạn ngạch",

  "cws.quota.unknown": "Không xác định hạn ngạch",

  "cws.quota.allExhausted": "Tất cả các mục tiêu được bật đều đã hết hạn ngạch. Hãy chọn một mục tiêu khác hoặc chờ hạn ngạch được phục hồi.",

  "cws.aboutTitle": "Thời gian chạy (Runtime)",

  "cws.aboutBody": "Các mục tiêu gặp lỗi sẽ được làm mát (cool down) trong một khoảng thời gian ngắn, tuân theo Retry-After. Các lỗi ngữ cảnh (context error) hoặc không hợp lệ sẽ không bị chuyển tiếp (hop). Mỗi mục tiêu sẽ thích ứng mức độ suy luận (effort) theo khả năng riêng của nó; các combo đã cạn kiệt sẽ bị từ chối (fail closed). Nhật ký (Logs) và Mức sử dụng (Usage) sẽ giữ nguyên thứ tự các lần thử vật lý và mức sử dụng trên từng lần thử.",

  "cws.removeConfirmTitle": "Xóa {model}?",

  "cws.removeConfirmDesc": "Hành động này sẽ xóa model ảo khỏi cấu hình và danh mục Codex. Nó không xóa bất kỳ provider nào.",

  "cws.unsavedTitle": "Các thay đổi chưa được lưu",

  "cws.unsavedDesc": "Loại bỏ các chỉnh sửa đối với combo này và tiếp tục?",

  "cws.keepEditing": "Tiếp tục chỉnh sửa",

  "cws.err.missingId": "Bắt buộc phải có Id của combo.",

  "cws.err.invalidId": "Id phải bắt đầu bằng một chữ cái hoặc số và chỉ sử dụng các chữ cái, số, dấu chấm, dấu gạch dưới hoặc dấu gạch ngang (tối đa 64 ký tự).",

  "cws.err.duplicateId": "Đã tồn tại một combo với id này.",

  "cws.err.invalidAlias": "Bí danh (alias) phải sử dụng các chữ cái, số, dấu chấm, dấu gạch dưới hoặc dấu gạch ngang, với tối đa một phân đoạn \"/\".",

  "cws.err.aliasReservedNamespace": "Bí danh không được sử dụng namespace dành riêng \"combo/\".",

  "cws.err.aliasNativeFamily": "Không được phép sử dụng các bí danh trần (bare aliases) thuộc bộ OpenAI gốc (gpt-*, o1-*, o3-*, o4-*, codex-*).",

  "cws.err.unsupportedNativeAlias": "Bí danh gốc (native alias) phải là một id model OpenAI trần (bare OpenAI model id) hiện đang được hỗ trợ.",

  "cws.err.missingNativeAliasDisplayName": "Bắt buộc phải có tên hiển thị đối với các bí danh gốc.",

  "cws.err.invalidDisplayName": "Tên hiển thị phải có tối đa 128 ký tự và không chứa các ký tự điều khiển (control characters).",

  "cws.err.duplicateAlias": "Một combo khác đã sử dụng bí danh này.",

  "cws.err.noTargets": "Hãy thêm ít nhất một mục tiêu.",

  "cws.err.incompleteTarget": "Mỗi mục tiêu cần một provider và model.",

  "cws.target.disabled": "{name} (bị vô hiệu hóa)",

  "cws.err.reservedNamespace": "Một provider vật lý có tên là combo phải được đổi tên trước khi tạo các combo.",

  "cws.err.providerCollision": "ID của combo bị xung đột với một tên provider đã được cấu hình.",

  "cws.err.unknownProvider": "Mỗi mục tiêu phải sử dụng một provider đã được cấu hình.",

  "cws.err.duplicateTarget": "Cùng một mục tiêu provider/model chỉ có thể xuất hiện một lần.",

  "cws.err.invalidStickyLimit": "Số lần thành công giữ nguyên (sticky successes) phải là một số nguyên từ 1 đến 100.",

  "cws.err.invalidWeight": "Mỗi trọng số round-robin phải là một số nguyên từ 1 đến 10000.",

  "cws.err.noEnabledTarget": "Ít nhất một mục tiêu phải sử dụng một provider đã được bật.",

  "claude.tabsLabel": "Client Claude",

  "claude.tabCode": "Code",

  "claude.tabDesktop": "Desktop",

  "claudeDesktop.title": "Claude Desktop",

  "claudeDesktop.subtitle": "Định tuyến từng họ model (model family) Claude thông qua một model khả dụng trên cổng {port}.",

  "claudeDesktop.importJson": "Nhập JSON",

  "claudeDesktop.exportJson": "Xuất JSON",

  "claudeDesktop.loading": "Đang tải hồ sơ Claude Desktop…",

  "claudeDesktop.loadFail": "Không thể tải hồ sơ Claude Desktop.",

  "claudeDesktop.retry": "Thử lại",
  "claudeDesktop.saveFailed": "Không thể lưu hồ sơ Claude Desktop.",

  "claudeDesktop.applyFailed": "Hồ sơ đã được lưu, nhưng không thể áp dụng.",

  "claudeDesktop.updateFailed": "Cập nhật Claude Desktop thất bại.",

  "claudeDesktop.savedApplied": "Hồ sơ đã được lưu và áp dụng cho Claude Desktop.",

  "claudeDesktop.appliedMarkerUnsaved": "Đã được áp dụng cho Claude Desktop, nhưng dấu (marker) áp dụng chưa được lưu — trạng thái đã lưu-so với-đã áp dụng bên dưới có thể hiển thị dữ liệu cũ cho đến khi bạn áp dụng lại.",

  "claudeDesktop.savedAppliedAnnounce": "Hồ sơ Claude Desktop đã được lưu và áp dụng.",

  "claudeDesktop.saved": "Hồ sơ đã được lưu.",

  "claudeDesktop.savedAnnounce": "Hồ sơ Claude Desktop đã được lưu.",

  "claudeDesktop.exported": "Hồ sơ đã được xuất dưới dạng JSON.",

  "claudeDesktop.importExpected": "Cần có một hồ sơ Claude Desktop phiên bản 1.",

  "claudeDesktop.importReady": "Đã nhập JSON. Hãy xem lại bản nháp, sau đó lưu và áp dụng.",

  "claudeDesktop.importedAnnounce": "Đã nhập JSON hồ sơ. Các thay đổi chưa được lưu đã sẵn sàng để xem xét.",

  "claudeDesktop.importInvalid": "Tệp đã chọn không phải là một hồ sơ hợp lệ.",

  "claudeDesktop.importFailed": "Nhập thất bại. {error}",

  "claudeDesktop.moved": "{route} đã được chuyển đến {family}.",

  "claudeDesktop.unsaved": "Các thay đổi chưa được lưu",

  "claudeDesktop.upToDate": "Hồ sơ đã được cập nhật",

  "claudeDesktop.saving": "Đang lưu…",

  "claudeDesktop.applying": "Đang áp dụng…",
  "claudeDesktop.saveApply": "Lưu & áp dụng",

  "claudeDesktop.emptyTitle": "Không có model nào khả dụng",

  "claudeDesktop.emptyHint": "Hãy thêm hoặc bật một provider, sau đó quay lại để chỉ định các định tuyến cho Claude Desktop.",

  "claudeDesktop.assignmentsLabel": "Các chỉ định họ model Claude",

  "claudeDesktop.family.opus": "Opus",

  "claudeDesktop.family.fable": "Fable",

  "claudeDesktop.family.sonnet": "Sonnet",

  "claudeDesktop.family.haiku": "Haiku",

  "claudeDesktop.modelCountOne": "{count} model",

  "claudeDesktop.modelCountMany": "{count} model",

  "claudeDesktop.chooseDefault": "Chọn một model mặc định",

  "claudeDesktop.temporaryDefault": "Mặc định tạm thời",

  "claudeDesktop.laneEmpty": "Thả một model vào đây hoặc sử dụng bộ điều khiển Di chuyển (Move) của nó.",

  "claudeDesktop.laneNoMatch": "Không có model nào trong họ này khớp với tìm kiếm của bạn.",

  "nav.grok": "Grok",

  "grok.title": "Grok Build",

  "grok.subtitle": "Các model mà opencodex đã đăng ký trong cấu hình Grok của bạn.",

  "grok.loading": "Đang tải trạng thái Grok…",

  "grok.loadFail": "Không thể đọc cấu hình Grok.",

  "grok.notConfiguredTitle": "Grok Build chưa được kết nối",

  "grok.notConfiguredHint": "Hãy khởi động hoặc khởi động lại proxy với Grok đã được cài đặt và opencodex sẽ ghi một khối được quản lý (managed block) vào:",

  "grok.endpoint": "Endpoint",

  "grok.colModel": "Model",

  "grok.colAlias": "Bí danh Grok",

  "grok.colContext": "Ngữ cảnh (Context)",

  "grok.groupNative": "Các model gốc (Native models)",

  "grok.groupRouted": "Các model được định tuyến (Routed models)",

  "grok.enabledCount": "Đã đăng ký {on} trong tổng số {total}",

  "grok.saved": "Đã lưu lựa chọn.",

  "grok.savedApplied": "Lựa chọn đã được lưu và được ghi vào cấu hình Grok của bạn.",

  "grok.saveFailed": "Không thể lưu lựa chọn Grok.",

  "grok.applyFailed": "Lựa chọn đã được lưu, nhưng cấu hình Grok không thể được cập nhật.",

  "grok.applySkipped": "Lựa chọn đã được lưu. Cấu hình Grok không thay đổi.",

  "grok.saveApply": "Lưu & áp dụng",

  "grok.saving": "Đang lưu…",

  "grok.applying": "Đang áp dụng…",
  "grok.unsaved": "Các thay đổi chưa được lưu",

  "grok.upToDate": "Lựa chọn đã được cập nhật",

  "grok.toggleModel": "Đăng ký {id} với Grok",

  "claudeDesktop.available": "Khả dụng",
  "claudeDesktop.defaultBadge": "Mặc định",
  "claudeDesktop.supports1m": "1M",

  "claudeDesktop.unavailable": "Không khả dụng",
  "claudeDesktop.contextM": "ngữ cảnh {n}M",

  "claudeDesktop.contextK": "ngữ cảnh {n}k",

  "claudeDesktop.contextUnknown": "không xác định ngữ cảnh",

  "claudeDesktop.alias": "Bí danh",

  "claudeDesktop.useAsDefault": "Sử dụng làm mặc định cho {family}",

  "claudeDesktop.moveTo": "Chuyển đến",

  "claudeDesktop.move": "Di chuyển",

  "claudeDesktop.status.applied": "Đã áp dụng cho Desktop",

  "claudeDesktop.status.stale": "Cấu hình đã cũ — hãy áp dụng lại",

  "claudeDesktop.status.notApplied": "Chưa được áp dụng",

  "claudeDesktop.status.notActiveProfile": "Desktop đang phục vụ một hồ sơ khác — hãy áp dụng lại",

  "claudeDesktop.status.disabled": "Tiện ích tích hợp Claude Desktop đang tắt. Hãy thoát hoàn toàn và mở lại Desktop sau khi bật nó.",

  "claudeDesktop.enableApply": "Bật và áp dụng",

  "claudeDesktop.health.lastRequest": "Yêu cầu cuối cùng (Last request)",

  "claudeDesktop.health.stats": "{count} req / {errors} err",

  "claudeDesktop.effort.supported": "suy luận (effort)",

  "claudeDesktop.effort.displayOnly": "suy luận (chỉ hiển thị)",


  // compatibility lab (CL-05)
  "lab.title": "Phòng thí nghiệm tương thích",

  "lab.subtitle": "Ma trận phán quyết tính tương thích (compatibility verdict matrix) chỉ đọc từ các bằng chứng dự báo của lab.",

  "lab.loadFailed": "Không thể tải dữ liệu compatibility lab",

  "lab.projectionUnavailable": "Dự báo của lab không có sẵn. Hãy chạy các bài kiểm tra conformance (tính tuân thủ) hoặc live probes (thăm dò trực tiếp) trước.",

  "lab.projectionIncompatible": "Lược đồ dự báo của lab không tương thích. Hãy xây dựng lại dự báo (projection).",

  "lab.statusTitle": "Trạng thái dự báo",

  "lab.matrixTitle": "Ma trận tương thích",

  "lab.verdictsTitle": "Các bản ghi phán quyết (Verdict records)",

  "lab.filter.layer": "Lớp bằng chứng (Evidence layer)",

  "lab.filter.verdict": "Phán quyết (Verdict)",

  "lab.filter.subject": "ID đối tượng (Subject ID)",

  "lab.filter.all": "Tất cả",
  "lab.col.subject": "Đối tượng (Subject)",

  "lab.col.layer": "Lớp (Layer)",

  "lab.col.suite": "Bộ kiểm thử (Suite)",

  "lab.col.verdict": "Phán quyết",

  "lab.col.asOf": "Tính đến",

  "lab.col.protocol": "Tuân thủ giao thức (Protocol conformance)",

  "lab.col.live": "Tính tương thích của định tuyến trực tiếp (Live route compatibility)",

  "lab.col.task": "Hiệu quả tác vụ (Task effectiveness)",

  "lab.empty": "Chưa có phán quyết tương thích nào trong dự báo.",

  "lab.subjectKind": "Loại (Kind)",

  "lab.observationCount": "Quan sát (Observations)",

  "lab.eventCount": "Sự kiện (Events)",

  "lab.verdictCount": "Phán quyết (Verdicts)",

  "lab.subjectCount": "Đối tượng (Subjects)",

  "lab.builtAt": "Đã xây dựng",

  "lab.loading": "Đang tải bằng chứng tương thích…",

  "lab.loadMore": "Tải thêm",

  "lab.detailTitle": "Chi tiết phán quyết",

  "lab.detailClose": "Đóng",
  "lab.detailSubject": "Đối tượng",

  "lab.detailObservations": "Quan sát",

  "lab.detailEvents": "Các sự kiện đóng góp (Contributing events)",

  "lab.detailArtifacts": "Siêu dữ liệu artifact (Artifact metadata)",

  "lab.production.title": "Lưu lượng truy cập production được quan sát",

  "lab.production.notVerification": "Không phải quy trình xác minh Lab (Lab verification)",

  "lab.production.attempts": "Số lần thử (Attempts)",

  "lab.production.successes": "Thành công (Successes)",

  "lab.production.routeErrors": "Lỗi định tuyến (Route errors)",

  "lab.production.lastObserved": "Quan sát lần cuối",

  "lab.detailLoadFailed": "Không thể tải chi tiết phán quyết",

  "lab.refresh": "Làm mới",
  "lab.verdict.UNKNOWN": "Không xác định",
  "lab.verdict.CLAIMED": "Đã xác nhận (Claimed)",

  "lab.verdict.PROBED": "Đã thăm dò (Probed)",

  "lab.verdict.VERIFIED": "Đã xác minh (Verified)",

  "lab.verdict.DEGRADED": "Đã xuống cấp (Degraded)",

  "lab.verdict.BLOCKED": "Đã bị chặn (Blocked)",

  "lab.verdict.UNSUPPORTED": "Không được hỗ trợ (Unsupported)",

  "lab.layer.protocol_conformance": "Tuân thủ giao thức (Protocol conformance)",

  "lab.layer.live_route_compatibility": "Tính tương thích của định tuyến trực tiếp (Live route compatibility)",

  "lab.layer.task_effectiveness": "Hiệu quả tác vụ (Task effectiveness)",


  "models.newPolicyGlobal": "Các model mới bắt đầu ở trạng thái tắt", "models.newPolicyProvider": "Chính sách model mới",

  "models.newPolicy_inherit": "Kế thừa", "models.newPolicy_off": "Tắt", "models.newPolicy_on": "Bật",

  "models.newBadge": "MỚI", "models.newCount": "{count} model mới, đã tắt",

  "models.aliases": "Bí danh (Aliases)",

  "models.aliasesTable": "Bảng bí danh (Alias table)",

  "models.aliasPrompt": "Bí danh provider (để trống để xóa)",

  "models.modelAliasPrompt": "Bí danh model (để trống để xóa)",

  "models.aliasSaved": "Đã lưu bí danh",

  "models.aliasConflict": "Bí danh đó xung đột với một tên đã tồn tại",

  "models.editProviderAlias": "Chỉnh sửa bí danh provider",

  "models.editModelAlias": "Chỉnh sửa bí danh model",

  "models.useDefaultAliases": "Sử dụng các bí danh mặc định",

  "models.useDefaultAliasesGlobal": "Sử dụng các bí danh mặc định toàn cục",

  "models.aliasAuto": "tự động (auto)",

  "models.aliasUser": "người dùng (user)",

  "models.aliasStale": "cũ (stale)",

  "connection.discovering": "Đang khám phá các mục tiêu cục bộ (local) và được chia sẻ…",

  "connection.machineUnavailable": "Mặt phẳng máy cục bộ (local machine plane) không khả dụng. Các yêu cầu chia sẻ đã không được chuyển hướng cục bộ.",

  "connection.disconnect": "Ngắt kết nối khỏi hub",

  "connection.disconnectConfirm": "Ngắt kết nối máy này khỏi hub và khởi động lại ở chế độ độc lập (standalone mode)?",

  "connection.pairing.title": "Kết nối dashboard này với hub",

  "connection.pairing.body": "Dán mã ghép nối một lần (one-time pairing code) được tạo trên hub.",

  "connection.pairing.relayWarning": "Mã này được trao đổi thông qua hub relay cố định. Không thể chuyển hướng relay sang một máy chủ khác.",

  "connection.pairing.code": "Mã ghép nối một lần",

  "connection.pairing.submit": "Kết nối",

  "connection.pairing.submitting": "Đang kết nối…",

  "connection.pairing.error": "Mã ghép nối đã bị từ chối hoặc hết hạn. Mã vẫn được giữ nguyên để bạn có thể kiểm tra.",

  "connection.machine.title": "Máy này",

  "connection.machine.shimHealthy": "Codex shim đang hoạt động bình thường.",

  "connection.machine.shimNeedsAttention": "Codex shim cần được chú ý.",

  "connection.machine.repairShim": "Sửa chữa shim",

  "connection.machine.removeShim": "Xóa shim",

  "connection.clients.title": "Các client đã kết nối",

  "connection.clients.none": "Không có trạng thái client nào khả dụng",

  "connection.clients.sync": "Đồng bộ ngay",

  "connection.clients.syncing": "Đang đồng bộ…",

  "connection.sessionLogout": "Đăng xuất phiên từ xa",

  "connection.sessionLoggingOut": "Đang đăng xuất phiên từ xa…",

  "connection.sessionLogoutFailed": "Không thể đăng xuất phiên từ xa. Phiên hiện tại vẫn được giữ nguyên.",

  "usage.source.connected": "Nguồn: mức sử dụng hub",

  "usage.source.local": "Nguồn: usage.jsonl cục bộ",

  "usage.scope.label": "Phạm vi sử dụng",

  "usage.scope.machine": "Máy này",

  "usage.scope.hub": "Toàn bộ hub",

  "usage.hubOffline": "Mức sử dụng hub không khả dụng. Mức sử dụng cục bộ đã không được dùng thay thế.",

  "models.displayNameSavedRefreshFailed": "Thay đổi đã được lưu, nhưng không thể làm mới danh sách model. Hãy thử lại để làm mới nó.",

  "models.displayNameOutcomeUnknown": "Yêu cầu chưa hoàn tất. Thay đổi có thể đã được lưu. Hãy thử lại để kiểm tra tên hiện tại trước khi thực hiện thay đổi khác.",

  "models.displayNameCurrentUnavailable": "Tên hiện tại không khả dụng cho đến khi làm mới",

  "models.displayNameReloaded": "Đã làm mới danh sách model",

  "models.displayNameAction": "Tên",
  "models.displayNameActionLabel": "Chỉnh sửa tên thân thiện (friendly name) cho {model}",

  "models.displayNameTitle": "Tên thân thiện",

  "models.displayNameModelId": "Model ID",

  "models.displayNameCurrent": "Tên hiện tại",

  "models.displayNameSourceOperator": "Tên của bạn",

  "models.displayNameSourceProvider": "Tên provider",

  "models.displayNameSourceFallback": "Dự phòng Model ID (Model ID fallback)",

  "models.displayNameField": "Tên thân thiện",

  "models.displayNamePlaceholder": "ví dụ: Grok 4.6",

  "models.displayNameHelp": "Chỉ thay đổi cách hiển thị. Việc định tuyến vẫn là {model}.",

  "models.displayNameReset": "Đặt lại tên",

  "models.displayNameSaved": "Đã lưu tên hiển thị",

  "models.displayNameResetDone": "Đã đặt lại tên hiển thị",

  "models.displayNameSaveFailed": "Không thể lưu tên hiển thị",

  "models.displayNameRequired": "Hãy nhập tên thân thiện, hoặc sử dụng Đặt lại tên.",

  "models.displayNameTooLong": "Tên thân thiện phải có độ dài từ 128 ký tự trở xuống.",

  "models.displayNameNoSlash": "Tên thân thiện không được chứa ký tự /.",

  "models.displayNameNoControl": "Tên thân thiện không được chứa các ký tự điều khiển (control characters).",

  "pricing.override.action": "Giá",

  "pricing.override.actionLabel": "Chỉnh sửa giá cho {model}",

  "pricing.override.badge": "Giá thủ công",

  "pricing.override.title": "Giá model",

  "pricing.override.modelId": "Model ID",

  "pricing.override.help": "USD cho mỗi 1M token. Nhập mức giá đầu vào (input) và đầu ra (output); mức giá cache nếu để trống sẽ tính là 0. Đặt cả bốn mức giá bằng 0 nghĩa là miễn phí.",

  "pricing.override.input": "Đầu vào (Input)",

  "pricing.override.output": "Đầu ra (Output)",

  "pricing.override.cacheRead": "Đọc bộ nhớ đệm (Cache read)",

  "pricing.override.cacheWrite": "Ghi bộ nhớ đệm (Cache write)",

  "pricing.override.loading": "Đang tải giá đã lưu…",

  "pricing.override.loadFailed": "Không thể tải giá đã lưu. Hãy tải lại để thử lại.",

  "pricing.override.outcomeUnknown": "Yêu cầu không hoàn tất một cách đáng tin cậy. Giá có thể đã thay đổi. Hãy tải lại giá đã lưu trước khi chỉnh sửa tiếp.",

  "pricing.override.recoveryFailed": "Không thể khôi phục giá đã lưu. Chức năng chỉnh sửa vẫn bị khóa; hãy tải lại để thử lại.",

  "pricing.override.recovered": "Đã tải giá được lưu mới nhất. Yêu cầu trước đó hoặc một client khác vẫn có thể thay đổi nó.",

  "pricing.override.refreshFailed": "Giá đã được lưu, nhưng không thể làm mới danh sách model. Hãy thử làm mới lại danh sách.",

  "pricing.override.invalid": "Hãy nhập mức giá đầu vào và đầu ra. Mỗi mức giá phải là một số hữu hạn từ 0 đến 1,000,000.",

  "pricing.override.reset": "Đặt lại thành tự động",

  "pricing.override.save": "Lưu",
  "pricing.override.saving": "Đang lưu…",

  "pricing.override.reload": "Tải lại giá",

  "pricing.override.refresh": "Làm mới danh sách",

  "pricing.override.cancel": "Hủy",
  "pricing.override.close": "Đóng",
  "usage.range.custom": "Phạm vi ngày tùy chỉnh",

  "usage.range.start": "Bắt đầu (giờ địa phương)",

  "usage.range.end": "Kết thúc (giờ địa phương)",

  "usage.range.apply": "Áp dụng",
  "usage.range.clear": "Xóa",

  "usage.range.help": "Giờ địa phương. Bao gồm toàn bộ phút kết thúc.",

  "usage.range.required": "Hãy nhập cả ngày và giờ bắt đầu cũng như kết thúc.",

  "usage.range.invalid": "Hãy nhập ngày và giờ địa phương hợp lệ, từ ngày 1970-01-01 UTC trở đi.",

  "usage.range.reversed": "Thời điểm kết thúc phải bằng hoặc sau thời điểm bắt đầu.",

  "usage.range.applied": "Khoảng thời gian đã chọn: {start} – {end} (bao gồm cả hai).",

  "models.pickerOrder.editorHint": "Sắp xếp lại các model được định tuyến, sau đó lưu bản nháp của bạn. Các hàng nổi bật (featured) được cố định; các model gốc (native) không được hiển thị.",

  "models.pickerOrder.nativeLocked": "Thứ tự đã lưu này bao gồm các model gốc. Hãy áp dụng một cài đặt sẵn (preset) định tuyến hoặc Mặc định (Default) trước khi chỉnh sửa Tùy chỉnh (Custom).",

  "models.pickerOrder.unknownChosen": "Các lựa chọn nổi bật không xác định. Hãy tải lại trước khi chỉnh sửa.",

  "models.pickerOrder.changed": "Cài đặt bộ chọn (picker) đã thay đổi. Bản nháp của bạn vẫn được giữ lại; hãy tải lại để loại bỏ nó và sử dụng cài đặt hiện tại.",

  "models.pickerOrder.savedReload": "Đã lưu thứ tự. Hãy tải lại cài đặt hiện tại trước khi chỉnh sửa lại.",

  "models.pickerOrder.requestFailed": "Yêu cầu thất bại. Bản nháp của bạn vẫn được giữ lại; hãy thử lại hoặc tải lại.",

  "models.pickerOrder.empty": "Không có model được định tuyến nào khả dụng.",

  "models.pickerOrder.dragModel": "Kéo {model}",

  "models.pickerOrder.featured": "Nổi bật (Featured)",

  "models.pickerOrder.upModel": "Di chuyển {model} lên",

  "models.pickerOrder.downModel": "Di chuyển {model} xuống",

  "models.pickerOrder.position": "{model}: vị trí {position} trong số {total}",

  "models.pickerOrder.saveDraft": "Lưu bản nháp",

  "models.pickerOrder.reloadDraft": "Tải lại và bỏ bản nháp",

  "models.pickerOrder.catalogRequired": "Danh tính của các model bị thiếu hoặc không rõ ràng. Hãy tải lại trang Models để làm mới danh mục của nó trước khi chỉnh sửa Tùy chỉnh (Custom).",

};
