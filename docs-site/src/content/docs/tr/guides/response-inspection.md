---
title: Yanıt incelemesi ve büyük yanıtlar
description: Sınırlı tanılama saklama ve akış incelemesinin yanıt teslimiyle nasıl etkileştiği.
---

OpenCodex, günlük sınırını istemcinize teslim edilen baytların sınırı haline
getirmeden yanıt tanılamasını sınırlar. Diğer sağlayıcı, istek ve aktarım
sınırları bağımsız olarak geçerlidir.

## JSON ve sıradan hata yanıtları

JSON incelemesi kaynak baytların en fazla 32 MiB kadarını saklar. Gövde bu
sınırı aşarsa günlükleme saklanan kopyayı bırakır ve özgün yanıtı iletmeyi
sürdürür. Kesilmiş bir öneki yetkili kullanım veya model meta verisi gibi
ayrıştırmaz. Başka bir güvenilir yoldan sağlanan kullanım korunur; eksik
kullanım için uydurma bir sıfır yazılmaz. JSON olmayan sıradan hata
tanılamaları yalnızca ilk 8 KiB'ı saklar ve mevcut gizleme mantığından geçer.

İstemci, tüm gövdenin tanılama incelemesini beklemek yerine parçaları
okundukça alır. Okuma hatası istek geçmişinde 502, iptal ise 499 olarak
kaydedilir; bu tanılama sonuçları önceden gönderilmiş HTTP başlıklarını
değiştirmez. Günlükleme bir kez sonlandırılır.

## Akış yanıtları

Yerel SSE incelemesi, istemci tüketiminin fazla önüne geçtiğinde duraklar.
İzin verilen alan 32 MiB artı kaynak parçası/yerel ön okuma ek yüküdür; toplam
yanıt boyutu sınırı veya tüm süreç belleği için üst sınır değildir. Daha uzun
bir yanıt da terminal kullanımı ve devam durumu dahil gerçek tamamlanma
olayına kadar incelenir.

İstemci bağlantısı kesildikten sonra mevcut sınırlı boşaltma, geç tamamlanmayı
15 saniyeye veya ek 32 MiB incelemeye kadar gözlemleyebilir. Zorunlu kapatma
farklıdır: tamamlanmamış adayları tamamlanmış yanıt olarak kaydetmek yerine
atar. Mevcut aktarım seçimi ve WebSocket bellek sınırları değişmez. Yeni bir
yapılandırma ayarı gerekmez.
