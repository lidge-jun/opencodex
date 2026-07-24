import Foundation

enum Text {
    static let isKorean = Locale.current.languageCode == "ko"

    static let appName = "OpenCodex"
    static var checking: String { isKorean ? "상태 확인 중…" : "Checking status…" }
    static var running: String { isKorean ? "프록시 실행 중" : "Proxy running" }
    static var stopped: String { isKorean ? "프록시 중지됨" : "Proxy stopped" }
    static var degraded: String { isKorean ? "프록시 상태 확인 필요" : "Proxy needs attention" }
    static var cliMissing: String { isKorean ? "ocx CLI를 찾을 수 없음" : "ocx CLI not found" }
    static var failed: String { isKorean ? "상태를 확인할 수 없음" : "Status unavailable" }
    static var openDashboard: String { isKorean ? "대시보드 열기" : "Open Dashboard" }
    static var start: String { isKorean ? "프록시 시작" : "Start Proxy" }
    static var restart: String { isKorean ? "프록시 재시작…" : "Restart Proxy…" }
    static var stop: String { isKorean ? "프록시 종료…" : "Stop Proxy…" }
    static var refresh: String { isKorean ? "상태 새로고침" : "Refresh Status" }
    static var chooseCLI: String { isKorean ? "ocx CLI 선택…" : "Choose ocx CLI…" }
    static var resetCLI: String { isKorean ? "CLI 자동 탐색 사용" : "Use Auto-detected CLI" }
    static var quit: String { isKorean ? "메뉴바 앱 종료" : "Quit Menu Bar App" }
    static var noService: String { isKorean ? "launchd 서비스 없음" : "No launchd service" }
    static var serviceStale: String { isKorean ? "서비스 손상 — 재설치 필요" : "Service stale — repair required" }
    static var repairService: String { isKorean ? "서비스 복구" : "Repair Service" }
    static var serviceRunning: String { isKorean ? "launchd 서비스 사용 중" : "Launchd service enabled" }
    static var serviceStopped: String { isKorean ? "launchd 서비스 중지됨" : "Launchd service stopped" }
    static var runtime: String { isKorean ? "Bun 런타임" : "Bun runtime" }
    static let cli = "ocx CLI"
    static var starting: String { isKorean ? "프록시 시작 중…" : "Starting proxy…" }
    static var restarting: String { isKorean ? "프록시 재시작 중…" : "Restarting proxy…" }
    static var stopping: String { isKorean ? "프록시 종료 중…" : "Stopping proxy…" }
    static var actionFailed: String { isKorean ? "프록시 제어 실패" : "Proxy Control Failed" }
    static var invalidCLI: String { isKorean ? "실행 가능한 ocx 파일을 선택해 주세요." : "Choose an executable ocx file." }
    static var restartTitle: String { isKorean ? "프록시를 재시작할까요?" : "Restart the proxy?" }
    static var stopTitle: String { isKorean ? "프록시를 종료할까요?" : "Stop the proxy?" }
    static var interruptionWarning: String {
        isKorean
            ? "진행 중인 요청이 중단될 수 있습니다. 종료하면 Codex 설정은 네이티브 상태로 복원됩니다."
            : "Active requests may be interrupted. Stopping also restores native Codex configuration."
    }
    static var cancel: String { isKorean ? "취소" : "Cancel" }
    static var confirmRestart: String { isKorean ? "재시작" : "Restart" }
    static var confirmStop: String { isKorean ? "종료" : "Stop" }
}
