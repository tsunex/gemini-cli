
import sys
import time
from datetime import datetime

def main():
    if len(sys.argv) < 2:
        # No need to print usage, just exit if no time is provided.
        return

    target_str = sys.argv[1]
    try:
        # Combine with today's date to create a full datetime object
        today = datetime.now().date()
        target_dt = datetime.combine(today, datetime.strptime(target_str, "%H:%M").time())
    except ValueError:
        # Silently fail on invalid format
        return

    now_dt = datetime.now()
    if now_dt > target_dt:
        return

    while now_dt < target_dt:
        print(f"現在の時刻は {now_dt.strftime('%H:%M:%S')} です。")
        # Recalculate sleep time to align with the 10-second mark
        sleep_duration = 10 - (now_dt.second % 10)
        time.sleep(sleep_duration)
        now_dt = datetime.now()
        # Break if we overshoot
        if now_dt >= target_dt:
            break

    print(f"{target_str} になりました。")

if __name__ == "__main__":
    main()
