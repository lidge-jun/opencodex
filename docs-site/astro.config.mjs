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
      // English at the site root; French under /fr, Korean under /ko, Simplified Chinese under /zh-cn, Traditional Chinese under /zh-tw, Russian under /ru, Japanese under /ja, Turkish under /tr.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        fr: { label: "Français", lang: "fr" },
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
          translations: { fr: "Démarrage", ko: "시작하기", "zh-CN": "开始使用", "zh-TW": "開始使用", ru: "Начало работы", ja: "はじめに", tr: "Başlangıç" },
          items: [
            { label: "Installation", translations: { fr: "Installation", ko: "설치", "zh-CN": "安装", "zh-TW": "安裝", ru: "Установка", ja: "インストール", tr: "Kurulum" }, slug: "getting-started/installation" },
            { label: "Quickstart", translations: { fr: "Démarrage rapide", ko: "빠른 시작", "zh-CN": "快速开始", "zh-TW": "快速入門", ru: "Быстрый старт", ja: "クイックスタート", tr: "Hızlı Başlangıç" }, slug: "getting-started/quickstart" },
            { label: "How It Works", translations: { fr: "Fonctionnement", ko: "동작 원리", "zh-CN": "工作原理", "zh-TW": "運作原理", ru: "Как это работает", ja: "仕組み", tr: "Nasıl Çalışır" }, slug: "getting-started/how-it-works" },
            { label: "Agent Quickstart", translations: { fr: "Démarrage rapide pour les agents", ko: "에이전트 퀵스타트", "zh-CN": "Agent 快速上手", "zh-TW": "Agent 快速上手", ru: "Быстрый старт для агентов", ja: "エージェント向けクイックスタート", tr: "Ajanlar İçin Hızlı Başlangıç" }, slug: "getting-started/for-agents" },
          ],
        },
        {
          label: "Guides",
          translations: { fr: "Guides", ko: "가이드", "zh-CN": "指南", "zh-TW": "指南", ru: "Руководства", ja: "ガイド", tr: "Kılavuzlar" },
          items: [
            { label: "Remote Hub Deployment", translations: { fr: "Déploiement Remote Hub", ko: "Remote Hub 배포", "zh-CN": "Remote Hub 部署", "zh-TW": "Remote Hub 部署", ru: "Развёртывание Remote Hub", ja: "Remote Hub のデプロイ", tr: "Remote Hub Dağıtımı" }, slug: "guides/remote-hub" },
            { label: "Providers", translations: { fr: "Fournisseurs", ko: "프로바이더", "zh-CN": "提供商", "zh-TW": "供應商", ru: "Провайдеры", ja: "プロバイダー", tr: "Sağlayıcılar" }, slug: "guides/providers" },
            { label: "Factory Droid Bridge", translations: { fr: "Pont Factory Droid", ko: "Factory Droid 브리지" }, slug: "guides/factory-droid" },
            { label: "Cursor Private Inference", translations: { ko: "Cursor Private Inference" }, slug: "guides/cursor-private-inference" },
            { label: "Model Routing", translations: { fr: "Routage des modèles", ko: "모델 라우팅", "zh-CN": "模型路由", "zh-TW": "模型路由", ru: "Маршрутизация моделей", ja: "モデルルーティング", tr: "Model Yönlendirme" }, slug: "guides/model-routing" },
            { label: "Codex Integration", translations: { fr: "Intégration de Codex", ko: "Codex 통합", "zh-CN": "Codex 集成", "zh-TW": "Codex 整合", ru: "Интеграция с Codex", ja: "Codex 連携", tr: "Codex Entegrasyonu" }, slug: "guides/codex-integration" },
            { label: "Codex App Model Picker", translations: { fr: "Sélecteur de modèles de Codex App", ko: "Codex App 모델 선택기", "zh-CN": "Codex App 模型选择器", "zh-TW": "Codex App 模型選擇器", ru: "Выбор модели в Codex App", ja: "Codex App モデルピッカー", tr: "Codex App Model Seçici" }, slug: "guides/codex-app-models" },
            { label: "Codex Prompt Layers", translations: { fr: "Couches d'invite Codex", ko: "Codex 프롬프트 레이어", "zh-CN": "Codex 提示词层", "zh-TW": "Codex 提示詞層", ru: "Слои промпта Codex", ja: "Codex プロンプトレイヤー", tr: "Codex İstem Katmanları" }, slug: "guides/codex-prompt" },
            { label: "Model Ordering", translations: { fr: "Ordre des modèles", ko: "모델 정렬에 관하여", "zh-CN": "模型排序", "zh-TW": "模型排序", ru: "Сортировка моделей", ja: "モデルの並び順", tr: "Model Sıralaması" }, slug: "guides/model-ordering" },
            { label: "Combos", translations: { fr: "Combinaisons", ko: "콤보", "zh-CN": "组合", "zh-TW": "組合", ru: "Комбо", ja: "コンボ", tr: "Kombolar" }, slug: "guides/combos" },
            { label: "Claude Code", translations: { fr: "Claude Code", ko: "Claude Code", "zh-CN": "Claude Code", "zh-TW": "Claude Code", ru: "Claude Code", ja: "Claude Code", tr: "Claude Code" }, slug: "guides/claude-code" },
            { label: "Grok Build", translations: { fr: "Grok Build", ko: "Grok Build", "zh-CN": "Grok Build", "zh-TW": "Grok Build", ru: "Grok Build", ja: "Grok Build", tr: "Grok Build" }, slug: "guides/grok-build" },
            { label: "opencode", translations: { fr: "opencode", ko: "opencode", "zh-CN": "opencode", "zh-TW": "opencode", ru: "opencode", ja: "opencode", tr: "opencode" }, slug: "guides/opencode" },
            { label: "Pi", translations: { fr: "Pi", ko: "Pi", "zh-CN": "Pi", "zh-TW": "Pi", ru: "Pi", ja: "Pi", tr: "Pi" }, slug: "guides/pi" },
            { label: "Integrations", translations: { fr: "Intégrations", ko: "연동", "zh-CN": "集成", "zh-TW": "整合", ru: "Интеграции", ja: "連携", tr: "Entegrasyonlar" }, slug: "guides/integrations" },
            { label: "MiniMax clients", translations: { fr: "Clients MiniMax", ko: "MiniMax 클라이언트", "zh-CN": "MiniMax 客户端", "zh-TW": "MiniMax 客戶端", ru: "Клиенты MiniMax", ja: "MiniMax クライアント", tr: "MiniMax İstemcileri" }, slug: "guides/minimax" },
            { label: "Sidecars: Web Search & Vision", translations: { fr: "Services auxiliaires : recherche web et vision", ko: "사이드카: 웹 검색 & 비전", "zh-CN": "边车：网络搜索与视觉", "zh-TW": "邊車：網路搜尋與視覺", ru: "Сайдкары: веб-поиск и зрение", ja: "サイドカー: ウェブ検索 & ビジョン", tr: "Sidecar'lar: Web Arama ve Görme" }, slug: "guides/sidecars" },
            { label: "Image Bridge", translations: { fr: "Pont d’images", ko: "이미지 브릿지", "zh-CN": "图像桥接", "zh-TW": "圖像橋接", ru: "Image Bridge", ja: "画像ブリッジ", tr: "Image Bridge" }, slug: "guides/image-bridge" },
            { label: "Video Bridge", translations: { fr: "Pont vidéo", ko: "비디오 브릿지", "zh-CN": "视频桥接", "zh-TW": "影片橋接", ru: "Video Bridge", ja: "動画ブリッジ", tr: "Video Bridge" }, slug: "guides/video-bridge" },
            { label: "Web Dashboard", translations: { fr: "Tableau de bord web", ko: "웹 대시보드", "zh-CN": "网页控制台", "zh-TW": "網頁儀表板", ru: "Веб-дашборд", ja: "ウェブダッシュボード", tr: "Web Kontrol Paneli" }, slug: "guides/web-dashboard" },
            { label: "Sub-agent Surface", translations: { fr: "Interface des sous-agents", ko: "서브에이전트 서피스", "zh-CN": "子代理界面", "zh-TW": "子代理介面", ru: "Интерфейс подагентов", ja: "サブエージェントサーフェス", tr: "Alt Ajan Arayüzü" }, slug: "guides/sub-agent-surface" },
          ],
        },
        {
          label: "Benchmarks",
          translations: { fr: "Bancs d’essai", ko: "벤치마크", "zh-CN": "基准测试", "zh-TW": "基準測試", ru: "Бенчмарки", ja: "ベンチマーク", tr: "Kıyaslamalar" },
          collapsed: true,
          items: [
            { label: "Overview", translations: { fr: "Vue d’ensemble", ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "benchmarks" },
            { label: "Coding", translations: { fr: "Programmation", ko: "코딩", "zh-CN": "编程", "zh-TW": "程式設計", ru: "Кодинг", ja: "コーディング", tr: "Kodlama" }, slug: "benchmarks/coding" },
            { label: "Frontend", translations: { fr: "Frontend", ko: "프론트엔드", "zh-CN": "前端", "zh-TW": "前端", ru: "Фронтенд", ja: "フロントエンド", tr: "Ön Yüz" }, slug: "benchmarks/frontend" },
            { label: "Terminal", translations: { fr: "Terminal", ko: "터미널", "zh-CN": "终端", "zh-TW": "終端", ru: "Терминал", ja: "ターミナル", tr: "Terminal" }, slug: "benchmarks/terminal" },
            { label: "Security", translations: { fr: "Sécurité", ko: "보안", "zh-CN": "安全", "zh-TW": "安全", ru: "Безопасность", ja: "セキュリティ", tr: "Güvenlik" }, slug: "benchmarks/security" },
            { label: "Intelligence", translations: { fr: "Intelligence", ko: "인텔리전스", "zh-CN": "智能", "zh-TW": "智慧", ru: "Интеллект", ja: "インテリジェンス", tr: "Zeka" }, slug: "benchmarks/intelligence" },
          ],
        },
        {
          label: "Reference",
          translations: { fr: "Référence", ko: "레퍼런스", "zh-CN": "参考", "zh-TW": "參考", ru: "Справочник", ja: "リファレンス", tr: "Referans" },
          items: [
            {
              label: "CLI",
              translations: { fr: "CLI", ko: "CLI", "zh-CN": "命令行", "zh-TW": "命令列", ru: "CLI", ja: "CLI", tr: "CLI" },
              items: [
                { label: "Overview", translations: { fr: "Vue d’ensemble", ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "reference/cli" },
                { label: "Lifecycle & Service", translations: { fr: "Cycle de vie et service", ko: "라이프사이클 & 서비스", "zh-CN": "生命周期与服务", "zh-TW": "生命週期與服務", ru: "Жизненный цикл и служба", ja: "ライフサイクル & サービス", tr: "Yaşam Döngüsü ve Servis" }, slug: "reference/cli/lifecycle" },
                { label: "Providers, Accounts & Models", translations: { fr: "Fournisseurs, comptes et modèles", ko: "프로바이더, 계정 & 모델", "zh-CN": "提供商、账户与模型", "zh-TW": "供應商、帳號與模型", ru: "Провайдеры, аккаунты и модели", ja: "プロバイダー・アカウント・モデル", tr: "Sağlayıcılar, Hesaplar ve Modeller" }, slug: "reference/cli/providers-accounts" },
                { label: "Agents, Routing & Integrations", translations: { fr: "Agents, routage et intégrations", ko: "에이전트, 라우팅 & 통합", "zh-CN": "代理、路由与集成", "zh-TW": "代理、路由與整合", ru: "Агенты, маршрутизация и интеграции", ja: "エージェント・ルーティング・連携", tr: "Ajanlar, Yönlendirme ve Entegrasyonlar" }, slug: "reference/cli/agents" },
              ],
            },
            {
              label: "Configuration",
              translations: { fr: "Configuration", ko: "설정", "zh-CN": "配置", "zh-TW": "設定", ru: "Конфигурация", ja: "設定", tr: "Yapılandırma" },
              items: [
                { label: "Overview", translations: { fr: "Vue d’ensemble", ko: "개요", "zh-CN": "概览", "zh-TW": "概覽", ru: "Обзор", ja: "概要", tr: "Genel Bakış" }, slug: "reference/configuration" },
                { label: "Providers", translations: { fr: "Fournisseurs", ko: "프로바이더", "zh-CN": "提供商", "zh-TW": "供應商", ru: "Провайдеры", ja: "プロバイダー", tr: "Sağlayıcılar" }, slug: "reference/configuration/providers" },
                { label: "Routing", translations: { fr: "Routage", ko: "라우팅", "zh-CN": "路由", "zh-TW": "路由", ru: "Маршрутизация", ja: "ルーティング", tr: "Yönlendirme" }, slug: "reference/configuration/routing" },
                { label: "Agents", translations: { fr: "Agents", ko: "에이전트", "zh-CN": "代理", "zh-TW": "代理", ru: "Агенты", ja: "エージェント", tr: "Ajanlar" }, slug: "reference/configuration/agents" },
                { label: "Server & Runtime", translations: { fr: "Serveur et environnement d’exécution", ko: "서버 & 런타임", "zh-CN": "服务器与运行时", "zh-TW": "伺服器與執行階段", ru: "Сервер и рантайм", ja: "サーバー & ランタイム", tr: "Sunucu ve Çalışma Zamanı" }, slug: "reference/configuration/server" },
              ],
            },
            { label: "Adapters", translations: { fr: "Adaptateurs", ko: "어댑터", "zh-CN": "适配器", "zh-TW": "適配器", ru: "Адаптеры", ja: "アダプター", tr: "Adaptörler" }, slug: "reference/adapters" },
            { label: "Architecture", translations: { fr: "Architecture", ko: "아키텍처", "zh-CN": "架构", "zh-TW": "架構", ru: "Архитектура", ja: "アーキテクチャ", tr: "Mimari" }, slug: "reference/architecture" },
            { label: "Proxy API Formats", translations: { fr: "Formats de l’API proxy", ko: "프록시 API 형식", "zh-CN": "代理 API 格式", "zh-TW": "代理 API 格式", ru: "Форматы API прокси", ja: "プロキシAPI形式", tr: "Proxy API Formatları" }, slug: "reference/proxy-formats" },
            { label: "Management API", translations: { fr: "API de gestion", ko: "관리 API", "zh-CN": "管理 API", "zh-TW": "管理 API", ru: "API управления", ja: "管理API", tr: "Yönetim API'si" }, slug: "reference/management-api" },
          ],
        },
        {
          label: "Troubleshooting",
          translations: { fr: "Dépannage", ko: "문제 해결", "zh-CN": "故障排除", "zh-TW": "疑難排解", ru: "Устранение неполадок", ja: "トラブルシューティング", tr: "Sorun Giderme" },
          collapsed: true,
          items: [
            { label: "Windows Memory Growth", translations: { fr: "Augmentation de la mémoire sous Windows", ko: "Windows 메모리 증가", "zh-CN": "Windows 内存增长", "zh-TW": "Windows 記憶體增長", ru: "Рост памяти в Windows", ja: "Windows メモリ増加", tr: "Windows Bellek Artışı" }, slug: "troubleshooting/windows-memory" },
            { label: "Disk Usage from Temp Files", translations: { fr: "Espace disque et fichiers temporaires", ko: "임시 파일 디스크 사용량", "zh-CN": "临时文件磁盘占用", "zh-TW": "暫存檔磁碟用量", ru: "Использование диска временными файлами", ja: "一時ファイルのディスク使用量", tr: "Geçici Dosya Disk Kullanımı" }, slug: "troubleshooting/disk-usage-temp-files" },
          ],
        },
        { label: "Contributing", translations: { fr: "Contribuer", ko: "기여하기", "zh-CN": "贡献", "zh-TW": "貢獻", ru: "Как внести вклад", ja: "コントリビュート", tr: "Katkıda Bulunma" }, slug: "contributing" },
      ],
    }),
  ],
});
