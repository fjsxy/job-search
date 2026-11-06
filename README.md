# 求职

需要 Node.js 22.13 或更新版本，以及 Make。

```sh
make start
```

在浏览器打开终端显示的本机地址。粘贴 JD 正文并保存，在职位详情中确认投递。重启服务后，可从首页打开已保存的职位与投递。

服务默认监听 `127.0.0.1:3000`，数据保存在仓库内的 `.job-search-data/`。可通过 `JOB_SEARCH_PORT` 和 `JOB_SEARCH_DATA_DIR` 指定其他本机端口和目录。

```sh
make test
```
