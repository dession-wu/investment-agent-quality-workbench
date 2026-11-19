# 投资 Agent 质量治理平台

面向投资Agent产品经理与质量运营，发现数值/口径错误和风险遗漏，建立修复候选，验证固定范围并保存结论。

在线产品：https://podnotes.cloud/investment/
固定源码：https://github.com/dession-wu/investment-agent-quality-workbench/tree/v1.0.0
演示视频及完整提交材料：https://github.com/dession-wu/investment-agent-quality-workbench/releases/tag/v1.0.0

## 运行主链路

首页新建排查 → 选择构造或生成回答 → 手动核验 → 对照证据记录问题 → 修改Prompt建立候选 → 验证固定范围 → 保存有限范围结论并导出。全范围无阻断才可记录通过，笔记与处置不改变检查事实。

## 核心设计与AI角色

模型抽取声明并辅助检查；确定性规则对齐数值口径；人工追加理由，不覆盖原始未知。候选冻结范围与核验依据，决定绑定修订。页面优先当前动作与结果，导航可收起；桌面80%—150%缩放保持相同结构，宽度不足可滚动。

## 数据使用

当前仅F02/F07A/F07B，2母题3变体；匿名构造财务及画像样例不是实时行情。历史28次真实调用只读保留，另有一条公开披露下载快照，不代表已接MCP。浏览器Cookie隔离任务，清除后无账号恢复；不采集真实投资账户。私有模型密钥仅服务端读取。

## 本版真实验证

后端44、VM57、本地Edge工作流22及真实浏览器缩放10项通过。模型替身与真实调用分开。本轮公网13项走查新增3次真实请求，原回答FAIL、候选PASS并保存F02范围结论，不报告整体准确率。录屏为连续公网页面操作，展示已保存结果，不新增调用。

## 本地启动与测试

Python3.12：`python server.py`，默认127.0.0.1:8765；可选服务端INVESTMENT_CONFIG配置，格式见server.py与.env.example。无密钥也可记录和查看历史。Docker使用Dockerfile和compose.yaml。执行`python test_mvp.py`、`node test_ui.cjs`；浏览器测试需Playwright与Edge。

全局/会话不设调用次数上限，历史计数保留；手动触发、单个在途、幂等、失败不自动重试仍有效。供应商额度由账户决定。

## 已知边界与未做事项

未接实时行情/iFinD/扶摇MCP、任意材料导入、生产行为反馈、企业登录多人审批、长期稳定性与完整合规对抗。auto并非固定模型，同源裁判不是独立金标，单例不能外推质量提升。SQLite留痕不是不可篡改存证。详细答卷与测试报告见docs及JSON。
