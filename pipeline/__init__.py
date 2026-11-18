"""StemPlay 本地资源生产管线（不进线上部署包，仅生产静态资产）。"""

__version__ = "0.7.0"

# 处理版本号：特征/分析算法变更时递增，第 4 轮缓存键的组成部分。
PIPELINE_VERSION = __version__

SCHEMA_VERSION = 1