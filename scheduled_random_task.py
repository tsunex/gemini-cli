
import sys
import time
import random
from datetime import datetime

def main():
    try:
        interval_secs = int(sys.argv[1])
    except (IndexError, ValueError):
        # Exit silently if args are wrong
        sys.exit(1)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Scheduled random task started. Will run every {interval_secs} seconds.")
    sys.stdout.flush() # Ensure the start message is printed immediately

    while True:
        # Wait for the next interval first
        time.sleep(interval_secs)

        # Then run the task
        result_code = random.choice([0, 1])
        result_str = "SUCCESS" if result_code == 0 else "FAILURE"

        print(f"[{datetime.now().strftime('%H:%M:%S')}] Periodic task report. Result: {result_str}")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
