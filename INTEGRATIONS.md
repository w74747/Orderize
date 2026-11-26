# ربط أنظمة الكاشير (POS) · POS integrations

| النظام | الفاتورة | تسجيل الدفع في POS | الربط |
| --- | --- | --- | --- |
| **Foodics** | مباشرة من الطلب المفتوح على الطاولة | يؤكده الموظف بضغطة («Recorded in POS») | OAuth من لوحة المطعم |
| **Oracle Simphony (STS Gen2)** | مباشرة من الشيك المفتوح باسم/رقم الطاولة | تلقائي (tender على الشيك) مع إعادة المحاولة | حساب API من Simphony |
| **Loyverse وأي POS آخر** | من لوحة سفرة أو واجهة POS الموقّعة | يؤكده الموظف بضغطة | وضع «Manual reconciliation» |
| **أي نظام لديه مطوّر** | يُرسل الفواتير عبر `POST /api/pos/v1/bills` (HMAC) | يسحب أحداث الدفع من `GET /api/pos/v1/events` | README.md |

## كيف تعمل المزامنة
1. عندما يمسح الزبون رمز الطاولة، يقرأ الخادم الطلب المفتوح من نظام الكاشير **لحظياً** (بحد أقصى مرة كل 8 ثوانٍ لكل طاولة).
2. الأصناف والإجمالي وما دُفع في الكاشير (كاش مثلاً) تُنسخ إلى سفرة؛ المتبقي = الإجمالي − ما دُفع في الكاشير − ما دُفع عبر سفرة.
3. إذا تعذّر الوصول إلى نظام الكاشير وكانت آخر مزامنة أقدم من دقيقة، **يُرفض الدفع** حتى لا يدفع أحد على فاتورة قديمة.
4. إذا أُغلق الطلب في الكاشير ولم يبدأ أحد بالدفع، تُغلق الفاتورة في سفرة تلقائياً.
5. بعد الدفع: Simphony يُسجَّل تلقائياً (8 محاولات بتأخير متزايد ثم تنبيه)، وFoodics/Loyverse تظهر في قائمة «Payments to record in the POS».

## Foodics — خطوات التفعيل
1. سجّل تطبيقاً في برنامج شركاء Foodics (Sandbox أولاً) واحصل على `client_id` و`client_secret`.
2. اضبط Redirect URL في تطبيق Foodics إلى: `https://YOUR_DOMAIN/api/integrations/foodics/callback`
3. أضف المتغيرات على Railway: `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET`, `FOODICS_ENV=sandbox` (ثم `production` بعد اعتماد Foodics).
4. من لوحة المطعم: POS integration → Connect Foodics → وافق داخل Foodics → اختر الفرع → Import tables from Foodics.
5. في Foodics أنشئ طريقة دفع باسم «Sufra» ليستخدمها الكاشير عند تسجيل دفعات سفرة.

## Oracle Simphony — خطوات التفعيل
1. في Simphony EMC أنشئ **API account** لـ STS Gen2 وفق دليل Oracle (Authentication and Authorization)، واحصل على `client_id` و`refresh_token`.
2. أنشئ Tender/Media خاصاً بسفرة، وموظف API، وسجّل أرقامهما.
3. من لوحة المطعم: POS integration → Oracle Simphony → أدخل البيانات → Test & connect (لا يُحفظ شيء إذا فشل الاختبار).
4. في «Simphony table mapping» اكتب اسم/رقم كل طاولة كما في Simphony، ثم «Check».

## الأمان
- التوكنات مشفّرة (AES-256-GCM) ولا تُعرض عبر أي واجهة؛ قطع الربط يحذفها.
- OAuth `state` عشوائي، صالح 10 دقائق، ويُستخدم مرة واحدة.
- عناوين Simphony يجب أن تكون HTTPS وتُحل إلى عناوين IP عامة (حماية SSRF)، بلا تتبع إعادة توجيه، مع مهلة 6 ثوانٍ.
- تسجيل الدفع في Simphony يستخدم `idempotencyId` = رقم الدفعة، فلا يُسجل مرتين حتى عند إعادة المحاولة.
- كل عملية ربط/قطع/استيراد/تأكيد تُسجَّل في سجل التدقيق.

## قبل الإطلاق (مهم)
أسماء الحقول ومسارات Foodics v5 وجسم طلب Simphony «round» مبنية على التوثيق العام، والاختبارات تعمل على خوادم محاكاة.
**يجب** تجربة الربط على Foodics Sandbox وعلى مختبر Simphony (Oracle Simphony Lab) قبل أول مطعم حقيقي، وتعديل
`src/pos/connectors/foodics.js` و`simphony.js` إن اختلفت الحقول.
