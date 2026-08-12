
import sys
import time
from datetime import datetime, timedelta

def main():
    if len(sys.argv) < 3:
        return

    try:
        duration_mins = float(sys.argv[1])
        interval_secs = float(sys.argv[2])
    except ValueError:
        return

    start_time = datetime.now()
    end_time = start_time + timedelta(minutes=duration_mins)

    print(f"通知を開始します。{duration_mins}分間、{interval_secs}秒ごとにお知らせします。（開始時刻: {start_time.strftime('%H:%M:%S')}）")

    next_notification = start_time + timedelta(seconds=interval_secs)
    while next_notification <= end_time:
        now = datetime.now()
        sleep_duration = (next_notification - now).total_seconds()
        if sleep_duration > 0:
            time.sleep(sleep_duration)

        print(f"現在の時刻は {datetime.now().strftime('%H:%M:%S')} です。")
        next_notification += timedelta(seconds=interval_secs)

    print("時間になりました。通知を終了します。")

if __name__ == "__main__":
    main()
