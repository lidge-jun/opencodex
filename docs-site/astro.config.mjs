// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Project GitHub Pages site: https://lidge-jun.github.io/opencodex
// `site` + `base` make Starlight emit correct absolute URLs and asset paths under the repo subpath.
const SITE_URL = "https://lidge-jun.github.io/opencodex";

// JSON-LD: WebSite + SoftwareApplication (docs SEO baseline; canonical/og/sitemap
// are emitted by Starlight itself).
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "opencodex",
      description:
        "Universal provider proxy for OpenAI Codex & Claude Code — use any LLM with Codex CLI, App, SDK, and Claude Code.",
      inLanguage: ["en", "ko", "zh-CN", "ru", "ja"],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "opencodex",
      alternateName: "ocx",
      description:
        "Local LLM proxy that lets OpenAI Codex (CLI, App, SDK) and Claude Code run on any model — Claude, Gemini, Grok, DeepSeek, Kimi, Qwen, Ollama, OpenRouter, and more — with streaming, tool calls, reasoning tokens, and images working in both directions.",
      keywords:
        "codex, claude code, openai codex proxy, claude code proxy, llm proxy, ai gateway, anthropic, gemini, grok, deepseek, ollama, openrouter, responses api, codex cli",
      featureList: [
        "Run Codex CLI/App/SDK on any LLM provider",
        "Run Claude Code on any LLM via the Anthropic Messages API",
        "ChatGPT account pool with quota-aware routing",
        "Streaming, tool calls, reasoning tokens, and vision in both directions",
        "Web dashboard on localhost:10100",
      ],
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      softwareHelp: { "@type": "CreativeWork", url: `${SITE_URL}/` },
      downloadUrl: "https://www.npmjs.com/package/@bitkyc08/opencodex",
      url: "https://github.com/lidge-jun/opencodex",
    },
  ],
});

export default defineConfig({
  site: "https://lidge-jun.github.io",
  base: "/opencodex",
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
      favicon: "/favicon.png",
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
        { tag: "meta", attrs: { property: "og:image", content: "https://lidge-jun.github.io/opencodex/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://lidge-jun.github.io/opencodex/og.png" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" } },
        { tag: "meta", attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#212121" } },
        { tag: "script", attrs: { type: "application/ld+json" }, content: jsonLd },
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
