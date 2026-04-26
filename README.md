# idea-planner

אפליקציית WEB לניהול רעיונות → אסטרטגיה/משימות → תתי־משימות עם תזמון (יום/שעה), סימון אוטומטי של הורה כשכל הילדים הושלמו, ומונים שמתעדכנים בזמן אמת.

## הרצה מקומית (הכי פשוט)

מריצים פקודה אחת וזה מרים גם את האפליקציה וגם את שרת התזכורות:

```powershell
cd "c:\פרוייקטים\יומן משימות"
npm install
npm install --prefix server
npm run dev
```

אחר כך פותחים: `http://localhost:5174`.

> אם את רוצה רק את האפליקציה בלי שרת תזכורות: `npm run dev:app`
> אם את רוצה רק את שרת התזכורות: `npm run dev:push`

## סנכרון בין מכשירים (Firebase)

כבר הוספתי שלד התחברות/סנכרון. כדי להפעיל בפועל:

- הפעילי בפרויקט Firebase:
  - **Authentication**: Email/Password
  - **Firestore**
- ערכי את `firebase-config.js`:
  - שימי את הערכים של `firebaseConfig`
  - החליפי `enableFirebaseSync` ל־`true`

אחרי זה, יופיע למעלה “מסונכרן: …” ותוכלי להתחבר באימייל וסיסמה, והנתונים יסתנכרנו בין מכשירים.

## התקנה לנייד (PWA)

אחרי שהאפליקציה רצה ב־`http://localhost:5173` (או אחרי שתעלי אותה לדומיין שלך):

- באנדרואיד (Chrome): תפריט ⋮ → **Add to Home screen / Install app**
- באייפון (Safari): Share → **Add to Home Screen**

## תזכורות אמיתיות (Web Push)

כדי שהתראות יעבדו גם כשהאפליקציה סגורה צריך להגדיר מפתחות VAPID לשרת.

### 1) יצירת מפתחות VAPID

```powershell
cd C:\Users\ilani\idea-planner\server
npm run gen:vapid
```

העתיקי את הפלט לקובץ `server\.env` לפי הדוגמה `server\.env.example`.

### 2) הפעלת התראות באפליקציה

פתחי את האפליקציה, לחצי למעלה על **“התראות”** ואשרי. מרגע זה:

- כל תת־משימה עם זמן **התחלה** תתוזמן כתזכורת
- שינוי זמן / סימון כבוצע / מחיקה יעדכנו את התזכורת בהתאם

## העלאה לענן (Render)

יש קובץ `render.yaml` שמאפשר להעלות בקלות ל־Render כ־Web Service אחד שמגיש גם את האתר וגם את שרת התזכורות.

ב־Render:
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start`
- השירות ייצור/ישמור נתונים על דיסק מתמשך (`/var/data`) כדי לשמור על `data.sqlite` ו־`vapid.json`.


