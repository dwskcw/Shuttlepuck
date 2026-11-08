import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY")
)

print("Sending request...", flush=True)

try:
    for chunk in client.models.generate_content_stream(
        model="gemini-3.5-flash-lite",
        contents="Say hello"
    ):
        if chunk.text:
            print(chunk.text, end="", flush=True)

    print("\nFinished!")

except Exception as e:
    print("\nERROR:", repr(e))