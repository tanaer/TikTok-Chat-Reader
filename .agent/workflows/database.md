---
description: 线上 PostgreSQL 数据库连接信息
---

# 线上数据库连接

每次提到"数据库"都是指这个线上 PostgreSQL 数据库：

**连接信息：**
- Host: `109.244.73.132`
- Port: `5566`
- Username: `postgres`
- Password: `qq123456`
- Database: `tkmonitor`

## Node.js 连接示例

```javascript
const { Pool } = require('pg');

const pool = new Pool({
    host: '109.244.73.132',
    port: 5566,
    database: 'tkmonitor',
    user: 'postgres',
    password: 'qq123456'
});
```

## 脚本中使用

在 `d:\code\TikTok-Chat-Reader` 项目中，确保 `.env` 文件包含：

```
PG_HOST=109.244.73.132
PG_PORT=5566
PG_DATABASE=tkmonitor
PG_USER=postgres
PG_PASSWORD=qq123456
```

## 命令行直接查询

```powershell
# 使用 node 查询
node -e "
const { Pool } = require('pg');
const pool = new Pool({host:'109.244.73.132',port:5566,database:'tkmonitor',user:'postgres',password:'qq123456'});
pool.query('YOUR_SQL_HERE').then(r => console.log(r.rows)).finally(() => pool.end());
"
```
