# 用法：. tools/idf_env.sh   —— 载入 ESP-IDF 环境（Python 3.12）
export PATH=/opt/homebrew/opt/python@3.12/libexec/bin:$PATH
export IDF_PATH="$HOME/esp/esp-idf-v5.5"
. "$IDF_PATH/export.sh" >/dev/null
