type Locale = "en" | "ko" | "de" | "fr" | "zh" | "zh-TW" | "ru" | "ja" | "tr" | "vi" | "pt" | "es";
const locales: readonly Locale[] = ["en", "ko", "de", "fr", "zh", "zh-TW", "ru", "ja", "tr", "vi", "pt", "es"];
type Row = readonly [string, string, string, string, string, string, string, string, string, string, string, string];

/** Models page "Overall" tab copy, one row per key in `locales` order. */
const rows = {
  "models.tab.overall": ["Overall", "전체", "Alle", "Tous", "全部", "全部", "Все", "すべて", "Tümü", "Tất cả", "Todos", "General"],
  "modelsOverall.lede": ["Every model from every provider in one list. Search, then switch a model on or off.", "모든 공급자의 모델을 한 목록에서 봅니다. 검색한 뒤 모델을 켜거나 끄세요.", "Alle Modelle aller Anbieter in einer Liste. Suche ein Modell und schalte es ein oder aus.", "Tous les modèles de tous les fournisseurs dans une seule liste. Recherchez, puis activez ou désactivez un modèle.", "所有供应商的模型都在一个列表里。搜索后即可开启或关闭模型。", "所有供應商的模型都在同一個清單中。搜尋後即可開啟或關閉模型。", "Все модели всех провайдеров в одном списке. Найдите модель и включите или выключите её.", "すべてのプロバイダーのモデルを 1 つのリストで表示します。検索して、モデルをオン・オフできます。", "Tüm sağlayıcıların modelleri tek listede. Arayın, ardından bir modeli açın veya kapatın.", "Mọi mô hình của mọi nhà cung cấp trong một danh sách. Tìm kiếm rồi bật hoặc tắt mô hình.", "Todos os modelos de todos os provedores em uma lista. Pesquise e ative ou desative um modelo.", "Todos los modelos de todos los proveedores en una sola lista. Busca y luego activa o desactiva un modelo."],
  "modelsOverall.title": ["All models", "전체 모델", "Alle Modelle", "Tous les modèles", "全部模型", "全部模型", "Все модели", "すべてのモデル", "Tüm modeller", "Tất cả mô hình", "Todos os modelos", "Todos los modelos"],
  "modelsOverall.search": ["Search all models", "모든 모델 검색", "Alle Modelle durchsuchen", "Rechercher dans tous les modèles", "搜索全部模型", "搜尋全部模型", "Поиск по всем моделям", "すべてのモデルを検索", "Tüm modellerde ara", "Tìm trong tất cả mô hình", "Pesquisar todos os modelos", "Buscar en todos los modelos"],
  "modelsOverall.filterLabel": ["Show", "표시", "Anzeigen", "Afficher", "显示", "顯示", "Показать", "表示", "Göster", "Hiển thị", "Mostrar", "Mostrar"],
  "modelsOverall.filter.all": ["All", "전체", "Alle", "Tous", "全部", "全部", "Все", "すべて", "Tümü", "Tất cả", "Todos", "Todos"],
  "modelsOverall.filter.on": ["On", "켜짐", "An", "Activés", "已开启", "已開啟", "Вкл.", "オン", "Açık", "Bật", "Ativados", "Activados"],
  "modelsOverall.filter.off": ["Off", "꺼짐", "Aus", "Désactivés", "已关闭", "已關閉", "Выкл.", "オフ", "Kapalı", "Tắt", "Desativados", "Desactivados"],
  "modelsOverall.noMatch": ["No models match.", "일치하는 모델이 없습니다.", "Keine passenden Modelle.", "Aucun modèle ne correspond.", "没有匹配的模型。", "沒有符合的模型。", "Подходящих моделей нет.", "一致するモデルはありません。", "Eşleşen model yok.", "Không có mô hình phù hợp.", "Nenhum modelo corresponde.", "Ningún modelo coincide."],
  "modelsOverall.empty": ["No models yet. Add a provider to list its models here.", "아직 모델이 없습니다. 공급자를 추가하면 여기에 모델이 표시됩니다.", "Noch keine Modelle. Füge einen Anbieter hinzu, um seine Modelle hier zu sehen.", "Aucun modèle pour l’instant. Ajoutez un fournisseur pour voir ses modèles ici.", "还没有模型。添加供应商后，它的模型会显示在这里。", "還沒有模型。新增供應商後，它的模型會顯示在這裡。", "Моделей пока нет. Добавьте провайдера, и его модели появятся здесь.", "まだモデルがありません。プロバイダーを追加すると、ここにモデルが表示されます。", "Henüz model yok. Modellerini burada görmek için bir sağlayıcı ekleyin.", "Chưa có mô hình. Thêm nhà cung cấp để xem mô hình tại đây.", "Ainda não há modelos. Adicione um provedor para ver os modelos dele aqui.", "Todavía no hay modelos. Añade un proveedor para ver sus modelos aquí."],
} as const satisfies Record<string, Row>;

export type ModelsOverallCopyKey = keyof typeof rows;

export function modelsOverallCopy(locale: Locale): Record<ModelsOverallCopyKey, string> {
  const index = locales.indexOf(locale);
  return Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[index]!])) as Record<ModelsOverallCopyKey, string>;
}

