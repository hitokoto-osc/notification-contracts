## 变更内容

<!-- 改了什么，为什么。受影响的生产方 / 消费方有哪些。 -->

## 自查

- [ ] 版本号已按 [README §7 的 SemVer 表](../README.md#7-我要改契约)判定，
      `asyncapi.yaml` 的 `info.version` 与 `package.json` 的 `version` 已同步
- [ ] CHANGELOG 已更新
- [ ] 新增 / 修改的字段已补进 `examples/`；若是收紧约束，已补 `examples/invalid/` 负样本

## 这是破坏性变更吗

破坏性变更指：改 routing key / queue / exchange / DLX 参数，或收紧 payload
（新增必填字段、删除枚举取值、加新约束）。

- [ ] **不是。** CI 的三道兼容性门禁应当全绿。
- [ ] **是。** 已打上 `topology-change` 或 `breaking-change` 标签，已升 MAJOR，
      并在上面写明了四语言生产方的迁移步骤。

## 消费方验证

- [ ] 已在 `notification_worker` 侧更新 submodule 指针并跑通 `Contract regression`
      （或已确认本次变更无需消费侧改动）
