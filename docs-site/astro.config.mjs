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
      // English at the site root; Korean under /ko, Simplified Chinese under /zh-cn, Russian under /ru, Japanese under /ja.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
        ru: { label: "Русский", lang: "ru" },
        ja: { label: "日本語", lang: "ja" },
      },
      sidebar: [
        {
          label: "Getting Started",
          translations: { ko: "시작하기", "zh-CN": "开始使用", ru: "Начало работы", ja: "はじめに" },
          items: [
            { label: "Installation", translations: { ko: "설치", "zh-CN": "安装", ru: "Установка", ja: "インストール" }, slug: "getting-started/installation" },
            { label: "Quickstart", translations: { ko: "빠른 시작", "zh-CN": "快速开始", ru: "Быстрый старт", ja: "クイックスタート" }, slug: "getting-started/quickstart" },
            { label: "How It Works", translations: { ko: "동작 원리", "zh-CN": "工作原理", ru: "Как это работает", ja: "仕組み" }, slug: "getting-started/how-it-works" },
          ],
        },
        {
          label: "Guides",
          translations: { ko: "가이드", "zh-CN": "指南", ru: "Руководства", ja: "ガイド" },
          items: [
            { label: "Providers", translations: { ko: "프로바이더", "zh-CN": "提供商", ru: "Провайдеры", ja: "プロバイダー" }, slug: "guides/providers" },
            { label: "Model Routing", translations: { ko: "모델 라우팅", "zh-CN": "模型路由", ru: "Маршрутизация моделей", ja: "モデルルーティング" }, slug: "guides/model-routing" },
            { label: "Codex Integration", translations: { ko: "Codex 통합", "zh-CN": "Codex 集成", ru: "Интеграция с Codex", ja: "Codex 連携" }, slug: "guides/codex-integration" },
            { label: "Codex App Model Picker", translations: { ko: "Codex App 모델 선택기", "zh-CN": "Codex App 模型选择器", ru: "Выбор модели в Codex App", ja: "Codex App モデルピッカー" }, slug: "guides/codex-app-models" },
            { label: "Model Ordering", translations: { ko: "모델 정렬에 관하여", "zh-CN": "模型排序", ru: "Сортировка моделей", ja: "モデルの並び順" }, slug: "guides/model-ordering" },
            { label: "Claude Code", translations: { ko: "Claude Code", "zh-CN": "Claude Code", ru: "Claude Code", ja: "Claude Code" }, slug: "guides/claude-code" },
            { label: "Grok Build", translations: { ko: "Grok Build", "zh-CN": "Grok Build", ru: "Grok Build", ja: "Grok Build" }, slug: "guides/grok-build" },
            { label: "opencode", translations: { ko: "opencode", "zh-CN": "opencode", ru: "opencode", ja: "opencode" }, slug: "guides/opencode" },
            { label: "Pi", translations: { ko: "Pi", "zh-CN": "Pi", ru: "Pi", ja: "Pi" }, slug: "guides/pi" },
            { label: "Sidecars: Web Search & Vision", translations: { ko: "사이드카: 웹 검색 & 비전", "zh-CN": "边车：网络搜索与视觉", ru: "Сайдкары: веб-поиск и зрение", ja: "サイドカー: ウェブ検索 & ビジョン" }, slug: "guides/sidecars" },
            { label: "Web Dashboard", translations: { ko: "웹 대시보드", "zh-CN": "网页控制台", ru: "Веб-дашборд", ja: "ウェブダッシュボード" }, slug: "guides/web-dashboard" },
            { label: "Sub-agent Surface", translations: { ko: "서브에이전트 서피스", "zh-CN": "子代理界面", ru: "Интерфейс подагентов", ja: "サブエージェントサーフェス" }, slug: "guides/sub-agent-surface" },
          ],
        },
        {
          label: "Benchmarks",
          translations: { ko: "벤치마크", "zh-CN": "基准测试", ru: "Бенчмарки", ja: "ベンチマーク" },
          collapsed: true,
          items: [
            { label: "Overview", translations: { ko: "개요", "zh-CN": "概览", ru: "Обзор", ja: "概要" }, slug: "benchmarks" },
            { label: "Coding", translations: { ko: "코딩", "zh-CN": "编程", ru: "Кодинг", ja: "コーディング" }, slug: "benchmarks/coding" },
            { label: "Frontend", translations: { ko: "프론트엔드", "zh-CN": "前端", ru: "Фронтенд", ja: "フロントエンド" }, slug: "benchmarks/frontend" },
            { label: "Terminal", translations: { ko: "터미널", "zh-CN": "终端", ru: "Терминал", ja: "ターミナル" }, slug: "benchmarks/terminal" },
            { label: "Security", translations: { ko: "보안", "zh-CN": "安全", ru: "Безопасность", ja: "セキュリティ" }, slug: "benchmarks/security" },
            { label: "Intelligence", translations: { ko: "인텔리전스", "zh-CN": "智能", ru: "Интеллект", ja: "インテリジェンス" }, slug: "benchmarks/intelligence" },
          ],
        },
        {
          label: "Reference",
          translations: { ko: "레퍼런스", "zh-CN": "参考", ru: "Справочник", ja: "リファレンス" },
          items: [
            { label: "CLI", translations: { ko: "CLI", "zh-CN": "命令行", ru: "CLI", ja: "CLI" }, slug: "reference/cli" },
            { label: "Configuration", translations: { ko: "설정", "zh-CN": "配置", ru: "Конфигурация", ja: "設定" }, slug: "reference/configuration" },
            { label: "Adapters", translations: { ko: "어댑터", "zh-CN": "适配器", ru: "Адаптеры", ja: "アダプター" }, slug: "reference/adapters" },
            { label: "Architecture", translations: { ko: "아키텍처", "zh-CN": "架构", ru: "Архитектура", ja: "アーキテクチャ" }, slug: "reference/architecture" },
          ],
        },
        {
          label: "Troubleshooting",
          translations: { ko: "문제 해결", "zh-CN": "故障排除", ru: "Устранение неполадок", ja: "トラブルシューティング" },
          collapsed: true,
          items: [
            { label: "Windows Memory Growth", translations: { ko: "Windows 메모리 증가", "zh-CN": "Windows 内存增长", ru: "Рост памяти в Windows", ja: "Windows メモリ増加" }, slug: "troubleshooting/windows-memory" },
          ],
        },
        { label: "Contributing", translations: { ko: "기여하기", "zh-CN": "贡献", ru: "Как внести вклад", ja: "コントリビュート" }, slug: "contributing" },
      ],
    }),
  ],
});
