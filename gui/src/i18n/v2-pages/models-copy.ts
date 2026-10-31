import { copyTable, type Row } from "./copy-table";

/*
 * Copy for the v2 Models page. Columns: en, ko, de, fr, zh, zh-TW, ru, ja, tr, vi, pt.
 * Keys render as `modelsV2.<key>`.
 */
const rows = {
  // ---- page head: one plain line per tab; the long description sits behind "About" ------
  ledeCatalog: ["Choose which models show up in the Codex model picker.", "Codex 모델 선택기에 보일 모델을 켜고 꺼요.", "Legen Sie fest, welche Modelle in der Codex-Modellauswahl erscheinen.", "Choisissez les modèles proposés dans le sélecteur de Codex.", "选择 Codex 模型选择器中显示哪些模型。", "選擇 Codex 模型選擇器中顯示哪些模型。", "Выберите, какие модели видны в списке моделей Codex.", "Codex のモデル選択に表示するモデルを選びます。", "Codex model seçicisinde hangi modellerin görüneceğini seçin.", "Chọn các mô hình hiển thị trong bộ chọn mô hình của Codex.", "Escolha quais modelos aparecem no seletor de modelos do Codex."],
  ledeCombos: ["Bundle several models under one id that answers in order.", "여러 모델을 하나의 id로 묶어 차례대로 응답하게 해요.", "Bündeln Sie mehrere Modelle unter einer ID, die der Reihe nach antworten.", "Regroupez plusieurs modèles sous un seul id qui répondent dans l'ordre.", "把多个模型合并到一个 id 下，按顺序响应。", "把多個模型合併到一個 id 下，依序回應。", "Объедините несколько моделей под одним id — они отвечают по очереди.", "複数のモデルを 1 つの id にまとめ、順番に応答させます。", "Birden çok modeli sırayla yanıt veren tek bir id altında toplayın.", "Gộp nhiều mô hình dưới một id và trả lời lần lượt.", "Agrupe vários modelos sob um único id que responde em ordem."],
  about: ["About this page", "이 화면 설명", "Über diese Seite", "À propos de cette page", "关于此页面", "關於此頁面", "Об этой странице", "このページについて", "Bu sayfa hakkında", "Về trang này", "Sobre esta página"],

  // ---- provider card -----------------------------------------------------------------------
  providerTools: ["Provider settings", "프로바이더 설정", "Anbietereinstellungen", "Réglages du fournisseur", "提供商设置", "提供者設定", "Настройки провайдера", "プロバイダー設定", "Sağlayıcı ayarları", "Cài đặt nhà cung cấp", "Configurações do provedor"],
  bulkLabel: ["Turn every model on or off", "모든 모델 켜기·끄기", "Alle Modelle ein- oder ausschalten", "Activer ou désactiver tous les modèles", "全部开启或关闭", "全部開啟或關閉", "Включить или выключить все модели", "すべてのモデルをオン・オフ", "Tüm modelleri aç veya kapat", "Bật hoặc tắt mọi mô hình", "Ativar ou desativar todos os modelos"],
  modelActions: ["Model actions", "모델 작업", "Modellaktionen", "Actions du modèle", "模型操作", "模型操作", "Действия с моделью", "モデルの操作", "Model işlemleri", "Thao tác mô hình", "Ações do modelo"],
} satisfies Record<string, Row>;

export const modelsV2Copy = copyTable("modelsV2", rows);
