export interface AgentResponse {
  answer: string;
}

export async function askAssistant(prompt: string, apiKey = 'sk-mock-key-for-test'): Promise<AgentResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a concise helpful assistant.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    answer: data.choices?.[0]?.message?.content ?? '',
  };
}
