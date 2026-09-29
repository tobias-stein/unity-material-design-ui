using TLab.UI.SDF;
using UnityEngine;
using UnityEngine.Rendering;

namespace mdu.ui
{
    public class SDFQuadMasked : SDFQuad
    {
        public override Material GetModifiedMaterial(Material baseMaterial)
        {
            var material = base.GetModifiedMaterial(baseMaterial);
            var newMaterial = new Material(material);

            newMaterial.SetFloat("_UseUIAlphaClip", 0);

            // --- Stencil Settings: Only draw if stencil buffer is NOT '1' ---
            // 1. Comparison: NotEqual. The test will pass only if the existing stencil buffer
            //    value is not equal to our Stencil ID.
            newMaterial.SetInt("_StencilComp", (int)CompareFunction.NotEqual);
            
            newMaterial.SetInt("_Stencil", 1);
            
            // 3. Operation: Keep the existing value in the buffer. We are only reading, not writing.
            newMaterial.SetInt("_StencilOp", (int)StencilOp.Keep);
            
            // 4. Write Mask: Do not write any new values to the buffer.
            newMaterial.SetInt("_StencilWriteMask", 0);
            
            // 5. Read Mask: Use all bits for the comparison.
            newMaterial.SetInt("_StencilReadMask", 255);

            return newMaterial;
        }
    }    
}