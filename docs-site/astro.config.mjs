// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Canonical GitHub Pages custom domain. The site is served at the domain root,
// so Starlight must not emit the former /opencodex project-site prefix.
const SITE_URL = "https://opencodex.me";

// NOTE: the WebSite / SoftwareApplication JSON-LD deliberately does NOT live here.
// Google only reads site-name markup from the home page of a site, and a global
// `head` entry would replay one `#website` entity (with the root `url`) on every
// docs page and every locale. Duplicated, conflicting WebSite objects are exactly
// what makes Google fall back to the domain ("opencodex.me") for the site name.
// The markup is emitted once per locale home page from `src/components/SiteJsonLd.astro`.

export default defineConfig({
  site: SITE_URL,
  trailingSlash: "ignore",
  // lightningcss merges animation-timeline into the `animation` shorthand,
  // which Chrome cannot parse — the scroll-driven animations die silently.
  vite: { build: { cssMinify: "esbuild" } },
  integrations: [
    starlight({
      title: "opencodex",
      description:
        "Universal provider proxy for OpenAI Codex & Claude Code — use any LLM with Codex CLI, App, SDK, and Claude Code.",
      tagline: "Use any LLM with OpenAI Codex and Claude Code.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        replacesTitle: false,
      },
      favicon: "/favicon.ico",
      customCss: [
        "@fontsource-variable/geist",
        "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css",
        "./src/styles/custom.css",
      ],
      components: {
        Header: "./src/components/Header.astro",
        PageTitle: "./src/components/PageTitle.astro",
      },
      head: [
        // Google favicon guidelines: PNG at a multiple of 48px, exposed via rel="icon".
        { tag: "link", attrs: { rel: "icon", type: "image/png", sizes: "192x192", href: "/favicon.png" } },
        { tag: "meta", attrs: { property: "og:image", content: `${SITE_URL}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE_URL}/og.png` } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#212121" } },
      ],
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/lidge-jun/opencodex" },
      ],
      editLink: {
        baseUrl: "https://github.com/lidge-jun/opencodex/edit/main/docs-site/",
      },
      lastUpdated: true,
      // English at the site root; Korean under /ko, Simplified Chinese under /zh-cn, Traditional Chinese under /zh-tw, Russian under /ru, Japanese under /ja, Turkish under /tr.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
        "zh-tw": { label: "繁體中文", lang: "zh-TW" },
        ru: { label: "Русский", lang: "ru" },
        ja: { label: "日本語", lang: "ja" },
        tr: { label: "Türkçe", lang: "tr" },
      },
      sidebar: [
        {
          label: "Getting Started",
          translations: { ko: "시작하기", "zh-CN": "开始使用", "zh-TW": "開始使用", ru: "Начало работы", ja: "はじめに", tr: "Başlangıç" },
          items: [
            { label: "Installation", translations: { ko: "설치", "zh-CN": "安装", "zh-TW": "安裝", ru: "Установка", ja: "インストール", tr: "Kurulum" }, slug: "getting-started/installation" },
            { label: "Quickstart", translations: { ko: "빠른 시작", "zh-CN": "快速开始", "zh-TW": "快速入門", ru: "Быстрый старт", ja: "クイックスタート", tr: "Hızlı Başlangıç" }, slug: "getting-started/quickstart" },
            { label: "How It Works", translations: { ko: "동작 원리", "zh-CN": "工作原理", "zh-TW": "運作原理", ru: "Как это работает", ja: "仕組み", tr: "Nasıl Çalışır" }, slug: "getting-started/how-it-works" },
            { label: "Agent Quickstart", translations: { ko: "에이전트 퀵스타트", "zh-CN": "Agent 快速上手", "zh-TW": "Agent 快速上手", ru: "Быстрый старт для агентов", ja: "エージェント向けクイックスタート", tr: "Ajanlar İçin Hızlı Başlangıç" }, slug: "getting-started/for-agents" },
          ],
        },
        {
          label: "Guides",
          translations: { ko: "가이드", "zh-CN": "指南", "zh-TW": "指南", ru: "Руководства", ja: "ガイド", tr: "Kılavuzlar" },
          items: [
            { label: "Providers", translations: { ko: "프로바이더", "zh-CN": "提供商", "zh-TW": "供應商", ru: "Провайдеры", ja: "プロバイダー", tr: "Sağlayıcılar" }, slug: "guides/providers" },
            { label: "Model Routing", translations: { ko: "모델 라우팅", "zh-CN": "模型路由", "zh-TW": "模型路由", ru: "Маршрутизация моделей", ja: "モデルルーティング", tr: "Model Yönlendirme" }, slug: "guides/model-routing" },
            { label: "Codex Integration", translations: { ko: "Codex 통합", "zh-CN": "Codex 集成", "zh-TW": "Codex 整合", ru: "Интеграция с Codex", ja: "Codex 連携", tr: "Codex Entegrasyonu" }, slug: "guides/codex-integration" },
            { label: "Codex App Model Picker", translations: { ko: "Codex App 모델 선택기", "zh-CN": "Codex App 模型选择器", "zh-TW": "Codex App 模型選擇器", ru: "Выбор модели в Codex App", ja: "Codex App モデルピッカー", tr: "Codex App Model Seçici" }, slug: "guides/codex-app-models" },
            { label: "Model Ordering", translations: { ko: "모델 정렬에 관하여", "zh-CN": "模型排序", "zh-TW": "模型排序", ru: "Сортировка моделей", ja: "モデルの並び順", tr: "Model Sıralaması" }, slug: "guides/model-ordering" },
            { label: "Combos", translations: { ko: "콤보", "zh-CN": "组合", "zh-TW": "組合", ru: "Комбо", ja: "コンボ", tr: "Kombolar" }, slug: "guides/combos" },
            { label: "Claude Code", translations: { ko: "Claude Code", "zh-CN": "Claude Code", "zh-TW": "Claude Code", ru: "Claude Code", ja: "Claude Code", tr: "Claude Code" }, slug: "guides/claude-code" },
            { label: "Grok Build", translations: { ko: "Grok Build", "zh-CN": "Grok Build", "zh-TW": "Grok Build", ru: "Grok Build", ja: "Grok Build", tr: "Grok Build" }, slug: "guides/grok-build" },
            { label: "opencode", translations: { ko: "opencode", "zh-CN": "opencode", "zh-TW": "opencode", ru: "opencode", ja: "opencode", tr: "opencode" }, slug: "guides/opencode" },
            { label: "Pi", translations: { ko: "Pi", "zh-CN": "Pi", "zh-TW": "Pi", ru: "Pi", ja: "Pi", tr: "Pi" }, slug: "guides/pi" },
            { label: "Integrations", translations: { ko: "연동", "zh-CN": "集成", "zh-TW": "整合", ru: "Интеграции", ja: "連携", tr: "Entegrasyonlar" }, slug: "guides/integrations" },
            { label: "Sidecars: Web Search & Vision", translations: { ko: "사이드카: 웹 검색 & 비전", "zh-CN": "边车：网络搜索与视觉", "zh-TW": "邊車：網路搜尋與視覺", ru: "Сайдкары: веб-поиск и зрение", ja: "サイドカー: ウェブ検索 & ビジョン", tr: "Sidecar'lar: Web Arama ve Görme" }, slug: "guides/sidecars" },
            { label: "Image Bridge", translations: { ko: "이미지 브릿지", "zh-CN": "图像桥接", "zh-TW": "圖像橋接", ru: "Image Bridge", ja: "画像ブリッジ", tr: "Image Bridge" }, slug: "guides/image-bridge" },
            { label: "Video Bridge", translations: { ko: "비디오 브릿지", "zh-CN": "视频桥接", "zh-TW": "影片橋接", ru: "Video Bridge", ja: "動画ブリッジ", tr: "Video Bridge" }, slug: "guides/video-bridge" },
            { label: "Web Dashboard", translations: { ko: "웹 대시보드", "zh-CN": "网页控制台", "zh-TW": "網頁儀表板", ru: "Веб-дашборд", ja: "ウェブダッシュボード", tr: "Web Kontrol Paneli" }, slug: "guides/web-dashboard" },
            { label: "Sub-agent Surface", translations: { ko: "서브에이전트 서피스", "zh-CN": "子代理界面", "zh-TW": "子代理介面", ru: "Интерфейс подагентов", ja: "サブエージェントサーフェス", tr: "Alt Ajan Arayüzü" }, slug: "guides/sub-agent-surface" },
          ],
        },
        {
          label: "Benchmarks",
          translations: { ko: "벤치마크", "zh-CN": "基准测试", "zh-TW": "基準測試", ru: "Бенчмарки", ja: "ベンチマーク", tr: "Kıyaslamalar" },
          collapsed: true,
          items: [
            { label: "Overview", translations: { ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "benchmarks" },
            { label: "Coding", translations: { ko: "코딩", "zh-CN": "编程", "zh-TW": "程式設計", ru: "Кодинг", ja: "コーディング", tr: "Kodlama" }, slug: "benchmarks/coding" },
            { label: "Frontend", translations: { ko: "프론트엔드", "zh-CN": "前端", "zh-TW": "前端", ru: "Фронтенд", ja: "フロントエンド", tr: "Ön Yüz" }, slug: "benchmarks/frontend" },
            { label: "Terminal", translations: { ko: "터미널", "zh-CN": "终端", "zh-TW": "終端", ru: "Терминал", ja: "ターミナル", tr: "Terminal" }, slug: "benchmarks/terminal" },
            { label: "Security", translations: { ko: "보안", "zh-CN": "安全", "zh-TW": "安全", ru: "Безопасность", ja: "セキュリティ", tr: "Güvenlik" }, slug: "benchmarks/security" },
            { label: "Intelligence", translations: { ko: "인텔리전스", "zh-CN": "智能", "zh-TW": "智慧", ru: "Интеллект", ja: "インテリジェンス", tr: "Zeka" }, slug: "benchmarks/intelligence" },
          ],
        },
        {
          label: "Reference",
          translations: { ko: "레퍼런스", "zh-CN": "参考", "zh-TW": "參考", ru: "Справочник", ja: "リファレンス", tr: "Referans" },
          items: [
            {
              label: "CLI",
              translations: { ko: "CLI", "zh-CN": "命令行", "zh-TW": "命令列", ru: "CLI", ja: "CLI", tr: "CLI" },
              items: [
                { label: "Overview", translations: { ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "reference/cli" },
                { label: "Lifecycle & Service", translations: { ko: "라이프사이클 & 서비스", "zh-CN": "生命周期与服务", "zh-TW": "生命週期與服務", ru: "Жизненный цикл и служба", ja: "ライフサイクル & サービス", tr: "Yaşam Döngüsü ve Servis" }, slug: "reference/cli/lifecycle" },
                { label: "Providers, Accounts & Models", translations: { ko: "프로바이더, 계정 & 모델", "zh-CN": "提供商、账户与模型", "zh-TW": "供應商、帳號與模型", ru: "Провайдеры, аккаунты и модели", ja: "プロバイダー・アカウント・モデル", tr: "Sağlayıcılar, Hesaplar ve Modeller" }, slug: "reference/cli/providers-accounts" },
                { label: "Agents, Routing & Integrations", translations: { ko: "에이전트, 라우팅 & 통합", "zh-CN": "代理、路由与集成", "zh-TW": "代理、路由與整合", ru: "Агенты, маршрутизация и интеграции", ja: "エージェント・ルーティング・連携", tr: "Ajanlar, Yönlendirme ve Entegrasyonlar" }, slug: "reference/cli/agents" },
              ],
            },
            {
              label: "Configuration",
              translations: { ko: "설정", "zh-CN": "配置", "zh-TW": "設定", ru: "Конфигурация", ja: "設定", tr: "Yapılandırma" },
              items: [
                { label: "Overview", translations: { ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "reference/configuration" },
                { label: "Providers", translations: { ko: "프로바이더", "zh-CN": "提供商", "zh-TW": "供應商", ru: "Провайдеры", ja: "プロバイダー", tr: "Sağlayıcılar" }, slug: "reference/configuration/providers" },
                { label: "Routing", translations: { ko: "라우팅", "zh-CN": "路由", "zh-TW": "路由", ru: "Маршрутизация", ja: "ルーティング", tr: "Yönlendirme" }, slug: "reference/configuration/routing" },
                { label: "Agents", translations: { ko: "에이전트", "zh-CN": "代理", "zh-TW": "代理", ru: "Агенты", ja: "エージェント", tr: "Ajanlar" }, slug: "reference/configuration/agents" },
                { label: "Server & Runtime", translations: { ko: "서버 & 런타임", "zh-CN": "服务器与运行时", "zh-TW": "伺服器與執行階段", ru: "Сервер и рантайм", ja: "サーバー & ランタイム", tr: "Sunucu ve Çalışma Zamanı" }, slug: "reference/configuration/server" },
              ],
            },
            { label: "Adapters", translations: { ko: "어댑터", "zh-CN": "适配器", "zh-TW": "適配器", ru: "Адаптеры", ja: "アダプター", tr: "Adaptörler" }, slug: "reference/adapters" },
            { label: "Architecture", translations: { ko: "아키텍처", "zh-CN": "架构", "zh-TW": "架構", ru: "Архитектура", ja: "アーキテクチャ", tr: "Mimari" }, slug: "reference/architecture" },
            { label: "Proxy API Formats", translations: { ko: "프록시 API 형식", "zh-CN": "代理 API 格式", "zh-TW": "代理 API 格式", ru: "Форматы API прокси", ja: "プロキシAPI形式", tr: "Proxy API Formatları" }, slug: "reference/proxy-formats" },
            { label: "Management API", translations: { ko: "관리 API", "zh-CN": "管理 API", "zh-TW": "管理 API", ru: "API управления", ja: "管理API", tr: "Yönetim API'si" }, slug: "reference/management-api" },
          ],
        },
        {
          label: "Troubleshooting",
          translations: { ko: "문제 해결", "zh-CN": "故障排除", "zh-TW": "疑難排解", ru: "Устранение неполадок", ja: "トラブルシューティング", tr: "Sorun Giderme" },
          collapsed: true,
          items: [
            { label: "Windows Memory Growth", translations: { ko: "Windows 메모리 증가", "zh-CN": "Windows 内存增长", "zh-TW": "Windows 記憶體增長", ru: "Рост памяти в Windows", ja: "Windows メモリ増加", tr: "Windows Bellek Artışı" }, slug: "troubleshooting/windows-memory" },
          ],
        },
        { label: "Contributing", translations: { ko: "기여하기", "zh-CN": "贡献", "zh-TW": "貢獻", ru: "Как внести вклад", ja: "コントリビュート", tr: "Katkıda Bulunma" }, slug: "contributing" },
      ],
    }),
  ],
});
