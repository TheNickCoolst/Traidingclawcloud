import { chat } from './src/llm.js';

async function test() {
    const result = await chat({
        messages: [{ role: 'user', content: 'What time is it? Please call the get_current_time tool.' }],
        systemPrompt: 'You must use tools when requested.',
        tools: [{
            type: 'function',
            function: {
                name: 'get_current_time',
                description: 'Get the current time',
                parameters: { type: 'object', properties: {} }
            }
        }]
    });
    console.log('Result:', JSON.stringify(result, null, 2));
}

test().catch(console.error);
