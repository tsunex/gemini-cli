
import os
import sys

file_path = "./text2.txt"

if os.path.exists(file_path):
    print(f"File '{file_path}' found.")
    sys.exit(0)  # 成功を示す終了コード 0
else:
    # ファイルが見つからない場合は何も出力せず、失敗を示す終了コード 1 を返す
    sys.exit(1)  # 失敗を示す終了コード 1
