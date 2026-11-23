# V6 动态检测计时与 CSV 说明

## 记录的时间点

每轮动态检测记录以下浏览器侧时间点：

| CSV 列 | 含义 |
| --- | --- |
| Start_Command_Time_UTC | 真正调用 `writeValueWithResponse` 发送 `A5 30 01 02 D8` 启动命令前的时间，不包含此前蓝牙写命令排队的时间 |
| Start_Command_Ack_Time_UTC | 上述蓝牙写入 Promise 成功返回的时间；它不是 ESP32 应用层或 ADC 启动确认 |
| Data_Complete_Time_UTC | 网页收到索引 0–223 的 224 个有效点并完成连续性/时间戳检查的时间；在发送停止命令和等待 45 ms 之前记录 |
| Inference_Start_Time_UTC | 本轮真正进入 `models.predict`、开始预处理与计算的时间 |
| Result_Ready_Time_UTC | 五个模型的最终平均浓度计算返回的时间；在更新图表、写入数据库之前记录 |

`UTC` 列采用 ISO 8601 格式，例如 `2026-11-23T06:25:30.123Z`。北京时间等于 UTC 加 8 小时。它们使用本次检测开始时的手机时间作为起点，再结合单调时钟生成，避免检测期间系统时钟调整影响时间间隔。

另有四个 `*_Elapsed_ms` 列，分别记录启动、收齐、开始识别、结果生成相对本次检测计时起点的毫秒数。

## 可直接分析的耗时

| CSV 列 | 计算方法与范围 |
| --- | --- |
| Acquisition_Elapsed_ms | 数据收齐 − 启动命令发送；包括蓝牙控制、固件采集、数据传输和网页通知处理 |
| Inference_Elapsed_ms | 结果生成 − 开始识别；包括滤光片对齐、SG 平滑、特征构造、五模型逐个计算和平均，包含期间的浏览器调度时间 |
| Data_To_Inference_Start_ms | 开始识别 − 数据收齐；包括停止命令、原有至少 45 ms 等待，以及前面轮次识别/存储造成的等待 |
| Total_Response_Elapsed_ms | 结果生成 − 启动命令发送；即这一轮从启动到得到结果的总延迟 |
| Start_Interval_ms | 本轮启动命令发送 − 上一轮启动命令发送；第一轮留空，用于观察实际采集周期 |

时间间隔使用 `performance.now()` 差值计算，保留 3 位小数；显示精度不等于硬件采样精度。结果生成时间不包含之后的图表绘制、页面实际刷新和存储耗时。

这些记录不能代表 ADC 硬件精确启停时间。如需该时间，需要增加固件侧硬件/采样时间遥测；本次没有修改固件。

## CSV 行结构

原有 9 列完整保留：

`Round, Time_s, Concentration_percent, Sample_Index, ESP_Time_us, Elapsed_In_Round_ms, CH2_mV, CH3_mV, Device_Round_Index`

新时间字段和 `Round_Status`、`Valid_Samples`、`Round_Error` 追加在后面。每轮 224 行原始点会重复携带相同的本轮时间字段。分析轮次耗时时，**按 Round 分组，每轮取一次**，不要当成 224 次独立检测。

`Time_s` 继续采用轮次 × 1.5 秒的原有名义横坐标。新加入的 `Start_Command_Elapsed_ms` 等字段才是本次实际测得的时间。没有修改浓度曲线的横坐标规则。

## 未完成和失败的轮次

- 发送过启动命令但中途停止、断连或采集不完整的轮次，也保留收到的原始点及已经发生的时间点。
- 一点都没收到时，导出一行记录该次启动；原始采样点字段为空，`Valid_Samples=0`，不补造数据。
- 没有收齐时，Data_Complete_Time_UTC 留空；没有生成有效结果时，Result_Ready_Time_UTC 留空，不填 0 或当前时间。
- `Round_Status` 可为 collecting / collected / predicting / completed / aborted / collection_failed / inference_failed。
- 即使没有浓度结果，只要记录了启动尝试，停止后也可下载 CSV。
- 当前运行中下载的是当时的快照。建议停止并等待计算结束后下载，或从 History 下载，以获得最终完整字段。
- 已完成/已终止轮次的时间随原始点一起保存在 History；旧 V5 记录的计时字段留空。
- 意外关闭页面、系统杀死浏览器或设备掉电可能丢失尚未提交到本地数据库的当前轮次。

## 版本与使用

- 新目录：`web_ble_site-V6`；V5 原目录保留。
- 界面布局、224 点要求、1500 ms 固件窗口、20% 舵机速度、LED 控制、45 ms 等待和 600 秒上限保持原有行为。
- 使用 V5 最近更新的五折模型 `20261107_220725`。
- 本次导出的 CSV 文件名以 `concentration_V6_` 开头。
- V6 沿用原网站的本地数据库与设置，不需要清除已有 History。
- 上传 GitHub Pages 时，建议用完整发布包覆盖；`timing.js` 是新增的必需文件，不要遗漏。
