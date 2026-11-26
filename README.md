# سفرة · Sufra

منصة دفع الفاتورة من الطاولة عبر رمز QR لمطاعم الخليج (فكرة مشابهة لـ qlub):
الزبون يمسح الرمز، يرى فاتورته، يقسّمها، يضيف الإكرامية، يطبّق خصم البنك أو كود الخصم، ويدفع.

> "Sufra" اسم مؤقت — غيّره من `package.json` والواجهات.

## المزايا
- **واجهة الزبون** (عربي/إنجليزي، RTL): الترحيب، عروض البنوك، القائمة، الفاتورة، تقسيم الفاتورة (كامل / بالتساوي / حسب الأصناف / مبلغ مخصص)، الإكرامية (نسب + مخصص)، كود خصم، موافقة تسويقية، الإيصال.
- **6 عملات خليجية**: AED, SAR, QAR, KWD, BHD, OMR (مع دعم 3 خانات عشرية للدينار والريال العماني).
- **لوحة المطعم**: الطاولات ورموز QR (تنزيل/تدوير)، فتح فاتورة يدوياً، المدفوعات مع تنبيهات، أكواد الخصم، المصادقة الثنائية، بيانات ربط نظام POS، سجل التدقيق.
- **ربط POS** بواجهة API موقّعة HMAC.
- **بوابات الدفع**: Tap Payments و Checkout.com (صفحة دفع مستضافة) + وضع Sandbox للتجربة.
- **الأمان**: راجع [SECURITY.md](SECURITY.md).

## التشغيل محلياً
```bash
# Node 20+ و PostgreSQL 14+
cp .env.example .env            # ضع APP_SECRET:  openssl rand -base64 48
npm install
export $(grep -v '^#' .env | xargs)
npm run seed                    # يطبع روابط الطاولات وبيانات دخول المالك
npm start                       # http://localhost:3000
npm test                        # يحتاج TEST_DATABASE_URL لقاعدة بيانات اختبار فارغة
```
بطاقات التجربة في Sandbox: `4242 4242 4242 4242` نجاح · `4000 0000 0000 0002` رفض.

## النشر (Railway أو أي منصة Docker)
1. أنشئ خدمة من هذا المجلد (Dockerfile جاهز) + قاعدة PostgreSQL.
2. المتغيرات: `DATABASE_URL`, `PUBLIC_BASE_URL` (https)، `APP_SECRET`، `PAYMENT_PROVIDER` ومفاتيح البوابة، `REQUIRE_2FA=true`.
3. الترحيل (migrations) يعمل تلقائياً عند الإقلاع.
4. سجّل رابط الويبهوك لدى البوابة: `https://YOUR_DOMAIN/api/webhooks/tap` أو `/api/webhooks/checkout`.

## ربط نظام POS
```
POST /api/pos/v1/bills
X-Pos-Key, X-Pos-Timestamp, X-Pos-Nonce,
X-Pos-Signature = hex(HMAC_SHA256(secret, `${ts}.${nonce}.POST./api/pos/v1/bills.${rawBody}`))
{"table_label":"S1 T1","external_ref":"CHK-1029","items":[{"name_en":"Latte","name_ar":"لاتيه","unit_price_minor":3200,"qty":2}],"vat_minor":305}

GET /api/pos/v1/events?after=<last_id>      # أحداث payment.captured (موقّعة بنفس الطريقة)
```

## البنية
```
shared/billing.js     حسابات المال (أعداد صحيحة فقط) — مشتركة بين الخادم والمتصفح
src/server.js         Fastify + الترويسات الأمنية + تحديد المعدل
src/services/         الفواتير والمدفوعات والمصادقة
src/payments/         sandbox | tap | checkout
src/routes/           public | admin | pos | webhooks | sandbox
src/migrations/       مخطط PostgreSQL
public/               واجهة الزبون ولوحة المطعم (بدون أطر عمل، بدون innerHTML)
test/                 اختبارات الحسابات والأمان
```

## قبل الإطلاق الفعلي
- اتفاقية تاجر مع بوابة الدفع، وتحقق من أسماء الحقول في توثيقها الحالي (`src/payments/tap.js`, `checkout.js`).
- اتفاقيات عروض مع البنوك (البنوك في البيانات التجريبية وهمية).
- اختبار اختراق خارجي + شهادة PCI SAQ-A + مراجعة قوانين حماية البيانات في كل دولة.
