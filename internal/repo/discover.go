package repo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	gitchatv1 "github.com/pders01/git-chat/gen/go/gitchat/v1"
)

// knownLocalPorts maps localhost ports to likely tool names.
var knownLocalPorts = []struct {
	Port int
	Name string
}{
	{1234, "LM Studio"},
	{11434, "Ollama"},
	{8080, "Local Server"},
	{5000, "Local Server"},
	{3000, "Local Server"},
}

// openAIModelsResponse is the subset of the OpenAI /v1/models response
// we need for discovery.
type openAIModelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// DiscoverLocal probes known localhost ports for OpenAI-compatible
// endpoints and returns any that respond with a valid /v1/models list.
// Called on-demand (user clicks "detect local"), not automatically.
func DiscoverLocal(ctx context.Context) []*gitchatv1.LocalEndpoint {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	client := &http.Client{Timeout: 800 * time.Millisecond}

	var mu sync.Mutex
	var results []*gitchatv1.LocalEndpoint
	var wg sync.WaitGroup

	for _, probe := range knownLocalPorts {
		wg.Add(1)
		go func(port int, name string) {
			defer wg.Done()

			baseURL := fmt.Sprintf("http://localhost:%d/v1", port)
			modelsURL := baseURL + "/models"

			req, err := http.NewRequestWithContext(ctx, "GET", modelsURL, nil)
			if err != nil {
				return
			}
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				return
			}

			var models openAIModelsResponse
			if err := json.NewDecoder(resp.Body).Decode(&models); err != nil {
				return
			}

			var modelIDs []string
			for _, m := range models.Data {
				if m.ID != "" {
					modelIDs = append(modelIDs, m.ID)
				}
			}

			mu.Lock()
			results = append(results, &gitchatv1.LocalEndpoint{
				Url:    baseURL,
				Name:   name,
				Models: modelIDs,
			})
			mu.Unlock()
		}(probe.Port, probe.Name)
	}

	wg.Wait()
	return results
}
